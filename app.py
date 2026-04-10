import os
import socket
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError
from flask import Flask, abort, jsonify, redirect, render_template, request, send_from_directory
from flask_socketio import SocketIO, emit
from sqlalchemy import (
    Column,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    delete,
    func,
    insert,
    select,
)
from werkzeug.utils import secure_filename


HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "5000"))
MAX_UPLOAD_MB = 50
MAX_MESSAGE_LENGTH = 500
MESSAGE_HISTORY_LIMIT = 300
READ_URL_TTL_SECONDS = int(os.getenv("PRESIGNED_URL_TTL", "3600"))

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR))
DB_FILE_PATH = Path(os.getenv("DB_PATH", DATA_DIR / "chat.db"))
LOCAL_UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", DATA_DIR / "uploads"))

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".m4v", ".ogg"}

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
S3_BUCKET_NAME = os.getenv("BUCKET", "").strip()
S3_ACCESS_KEY_ID = os.getenv("ACCESS_KEY_ID", "").strip()
S3_SECRET_ACCESS_KEY = os.getenv("SECRET_ACCESS_KEY", "").strip()
S3_ENDPOINT = os.getenv("ENDPOINT", "").strip()
S3_REGION = os.getenv("REGION", "auto").strip() or "auto"
S3_ADDRESSING_STYLE = os.getenv("S3_ADDRESSING_STYLE", "virtual").strip() or "virtual"
BUCKET_ENABLED = all([S3_BUCKET_NAME, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT])


app = Flask(__name__)
app.config["SECRET_KEY"] = "ks-chat-secret"
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
app.config["GIPHY_API_KEY"] = os.getenv("GIPHY_API_KEY", "").strip()
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

sessions = {}
sid_to_client_id = {}
typing_client_ids = set()


def normalize_database_url(raw_url):
    if not raw_url:
        return f"sqlite:///{DB_FILE_PATH.as_posix()}"

    if raw_url.startswith("postgres://"):
        return f"postgresql+psycopg://{raw_url[len('postgres://'):]}"

    if raw_url.startswith("postgresql://") and "+psycopg" not in raw_url:
        return raw_url.replace("postgresql://", "postgresql+psycopg://", 1)

    return raw_url


def create_db_engine():
    database_url = normalize_database_url(DATABASE_URL)
    engine_options = {
        "future": True,
        "pool_pre_ping": True,
    }

    if database_url.startswith("sqlite"):
        engine_options["connect_args"] = {"check_same_thread": False}

    return create_engine(database_url, **engine_options)


db_engine = create_db_engine()
db_metadata = MetaData()

messages_table = Table(
    "messages",
    db_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("nickname", String(50), nullable=False),
    Column("message_type", String(20), nullable=False),
    Column("text_content", Text, nullable=False, default=""),
    Column("media_url", Text, nullable=False, default=""),
    Column("media_kind", String(20), nullable=False, default=""),
    Column("gif_id", String(80), nullable=False, default=""),
    Column("gif_title", String(255), nullable=False, default=""),
    Column("created_at", String(32), nullable=False),
)

message_reads_table = Table(
    "message_reads",
    db_metadata,
    Column("message_id", Integer, ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True),
    Column("client_id", String(120), primary_key=True),
    Column("nickname", String(50), nullable=False),
    Column("read_at", String(32), nullable=False),
)


def create_storage_client():
    if not BUCKET_ENABLED:
        return None

    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        region_name=S3_REGION,
        config=BotoConfig(
            signature_version="s3v4",
            s3={"addressing_style": S3_ADDRESSING_STYLE},
        ),
    )


storage_client = create_storage_client()


def init_storage():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOCAL_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    db_metadata.create_all(db_engine)


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def current_time():
    return datetime.now().strftime("%H:%M")


def format_timestamp(iso_timestamp):
    return datetime.fromisoformat(iso_timestamp).strftime("%H:%M")


def get_local_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def sanitize_text(value, limit=MAX_MESSAGE_LENGTH):
    return (value or "").strip()[:limit]


def normalize_message_ids(values):
    message_ids = []
    seen = set()

    if not isinstance(values, list):
        return message_ids

    for value in values:
        try:
            message_id = int(value)
        except (TypeError, ValueError):
            continue

        if message_id <= 0 or message_id in seen:
            continue

        seen.add(message_id)
        message_ids.append(message_id)

    return message_ids


def active_users():
    return sorted(
        [session["nickname"] for session in sessions.values()],
        key=str.casefold,
    )


def broadcast_user_list():
    socketio.emit(
        "user_list",
        {
            "users": active_users(),
            "count": len(sessions),
        },
    )


def broadcast_typing_users():
    names = sorted(
        [
            sessions[client_id]["nickname"]
            for client_id in typing_client_ids
            if client_id in sessions
        ],
        key=str.casefold,
    )
    socketio.emit("typing_users", {"users": names})


def nickname_taken(nickname, client_id):
    lowered = nickname.casefold()
    return any(
        session["nickname"].casefold() == lowered and existing_client_id != client_id
        for existing_client_id, session in sessions.items()
    )


def build_media_url(media_path):
    return f"/uploads/{quote(media_path, safe='/')}" if media_path else ""


def row_to_message(row):
    return {
        "id": row["id"],
        "nickname": row["nickname"],
        "type": row["message_type"],
        "text": row["text_content"] or "",
        "media_url": build_media_url(row["media_url"]),
        "media_kind": row["media_kind"] or "",
        "gif_id": row["gif_id"] or "",
        "gif_title": row["gif_title"] or "",
        "timestamp": format_timestamp(row["created_at"]),
        "read_by": [],
    }


def get_read_map(message_ids):
    normalized_ids = normalize_message_ids(message_ids)
    if not normalized_ids:
        return {}

    with db_engine.connect() as connection:
        rows = connection.execute(
            select(message_reads_table.c.message_id, message_reads_table.c.nickname)
            .where(message_reads_table.c.message_id.in_(normalized_ids))
            .order_by(func.lower(message_reads_table.c.nickname))
        ).mappings().all()

    read_map = {message_id: [] for message_id in normalized_ids}
    for row in rows:
        read_map.setdefault(row["message_id"], []).append(row["nickname"])

    return read_map


def attach_read_receipts(messages):
    read_map = get_read_map([message["id"] for message in messages])

    for message in messages:
        message["read_by"] = read_map.get(message["id"], [])

    return messages


def load_history(limit=MESSAGE_HISTORY_LIMIT):
    recent_messages = (
        select(messages_table)
        .order_by(messages_table.c.id.desc())
        .limit(limit)
        .subquery("recent_messages")
    )

    with db_engine.connect() as connection:
        rows = connection.execute(
            select(recent_messages).order_by(recent_messages.c.id.asc())
        ).mappings().all()

    return attach_read_receipts([row_to_message(row) for row in rows])


def save_message(
    nickname,
    message_type,
    text_content="",
    media_url="",
    media_kind="",
    gif_id="",
    gif_title="",
):
    created_at = now_iso()

    with db_engine.begin() as connection:
        result = connection.execute(
            insert(messages_table)
            .values(
                nickname=nickname,
                message_type=message_type,
                text_content=text_content,
                media_url=media_url,
                media_kind=media_kind,
                gif_id=gif_id,
                gif_title=gif_title,
                created_at=created_at,
            )
            .returning(messages_table.c.id)
        )
        message_id = result.scalar_one()

    return {
        "id": message_id,
        "nickname": nickname,
        "type": message_type,
        "text": text_content,
        "media_url": build_media_url(media_url),
        "media_kind": media_kind,
        "gif_id": gif_id,
        "gif_title": gif_title,
        "timestamp": format_timestamp(created_at),
        "read_by": [],
    }


def iter_media_paths():
    with db_engine.connect() as connection:
        rows = connection.execute(
            select(messages_table.c.media_url).where(messages_table.c.media_url != "")
        ).scalars().all()

    return [row for row in rows if row]


def delete_media_objects(media_paths):
    unique_paths = sorted(set(path for path in media_paths if path))
    if not unique_paths:
        return

    if storage_client:
        for start in range(0, len(unique_paths), 1000):
            chunk = unique_paths[start:start + 1000]
            storage_client.delete_objects(
                Bucket=S3_BUCKET_NAME,
                Delete={"Objects": [{"Key": path} for path in chunk]},
            )
        return

    for media_path in unique_paths:
        target = LOCAL_UPLOAD_DIR / media_path
        if target.exists():
            target.unlink()


def clear_history_store():
    media_paths = iter_media_paths()

    with db_engine.begin() as connection:
        connection.execute(delete(message_reads_table))
        connection.execute(delete(messages_table))

    delete_media_objects(media_paths)


def allowed_upload(file_name):
    extension = Path(file_name).suffix.lower()
    if extension in ALLOWED_IMAGE_EXTENSIONS:
        return "image"
    if extension in ALLOWED_VIDEO_EXTENSIONS:
        return "video"
    return ""


def current_session():
    client_id = sid_to_client_id.get(request.sid)
    return client_id, sessions.get(client_id)


def mark_messages_read(client_id, nickname, message_ids):
    normalized_ids = normalize_message_ids(message_ids)
    if not normalized_ids:
        return []

    with db_engine.begin() as connection:
        valid_ids = connection.execute(
            select(messages_table.c.id)
            .where(messages_table.c.id.in_(normalized_ids))
            .where(messages_table.c.nickname != nickname)
        ).scalars().all()

        if not valid_ids:
            return []

        connection.execute(
            delete(message_reads_table)
            .where(message_reads_table.c.client_id == client_id)
            .where(message_reads_table.c.message_id.in_(valid_ids))
        )

        timestamp = now_iso()
        connection.execute(
            insert(message_reads_table),
            [
                {
                    "message_id": message_id,
                    "client_id": client_id,
                    "nickname": nickname,
                    "read_at": timestamp,
                }
                for message_id in valid_ids
            ],
        )

    read_map = get_read_map(valid_ids)
    return [
        {
            "message_id": message_id,
            "read_by": read_map.get(message_id, []),
        }
        for message_id in valid_ids
    ]


def build_storage_key(filename):
    extension = Path(filename).suffix.lower()
    date_prefix = datetime.now().strftime("chat-media/%Y/%m")
    return f"{date_prefix}/{uuid.uuid4().hex}{extension}"


def upload_to_storage(uploaded_file):
    storage_key = build_storage_key(uploaded_file.filename)

    if storage_client:
        uploaded_file.stream.seek(0)
        content_type = uploaded_file.mimetype or "application/octet-stream"
        storage_client.upload_fileobj(
            uploaded_file.stream,
            S3_BUCKET_NAME,
            storage_key,
            ExtraArgs={"ContentType": content_type},
        )
        return storage_key

    destination = LOCAL_UPLOAD_DIR / storage_key
    destination.parent.mkdir(parents=True, exist_ok=True)
    uploaded_file.save(destination)
    return storage_key


def generate_presigned_download_url(storage_key):
    if not storage_client:
        return ""

    return storage_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET_NAME, "Key": storage_key},
        ExpiresIn=READ_URL_TTL_SECONDS,
    )


@app.route("/")
def index():
    return render_template(
        "index.html",
        giphy_api_key=app.config["GIPHY_API_KEY"],
        giphy_enabled=bool(app.config["GIPHY_API_KEY"]),
        max_upload_mb=MAX_UPLOAD_MB,
    )


@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    if storage_client:
        try:
            signed_url = generate_presigned_download_url(filename)
        except ClientError:
            abort(404)

        if not signed_url:
            abort(404)

        return redirect(signed_url, code=302)

    return send_from_directory(LOCAL_UPLOAD_DIR, filename)


@app.post("/upload")
def upload_file():
    client_id = (request.form.get("client_id") or "").strip()
    session = sessions.get(client_id)

    if not session:
        return jsonify({"message": "먼저 채팅방에 입장해주세요."}), 403

    uploaded_file = request.files.get("file")
    if not uploaded_file or not uploaded_file.filename:
        return jsonify({"message": "업로드할 파일을 선택해주세요."}), 400

    media_kind = allowed_upload(uploaded_file.filename)
    if not media_kind:
        return jsonify({"message": "이미지 또는 영상 파일만 전송할 수 있습니다."}), 400

    safe_name = secure_filename(uploaded_file.filename)
    storage_key = upload_to_storage(uploaded_file)

    return jsonify(
        {
            "media_url": build_media_url(storage_key),
            "media_kind": media_kind,
            "storage_key": storage_key,
            "original_name": safe_name,
        }
    )


@app.errorhandler(413)
def file_too_large(_error):
    return jsonify({"message": f"파일 크기는 최대 {MAX_UPLOAD_MB}MB까지 가능합니다."}), 413


@socketio.on("join")
def handle_join(data):
    nickname = sanitize_text(data.get("nickname"), limit=20)
    client_id = sanitize_text(data.get("client_id"), limit=120)

    if not nickname:
        emit("join_error", {"message": "닉네임을 입력해주세요."})
        return

    if not client_id:
        emit("join_error", {"message": "세션 정보를 확인할 수 없습니다. 새로고침 후 다시 시도해주세요."})
        return

    if nickname_taken(nickname, client_id):
        emit("join_error", {"message": "이미 사용 중인 닉네임입니다."})
        return

    existing_session = sessions.get(client_id)
    is_new_user = existing_session is None

    if existing_session:
        previous_sid = existing_session["sid"]
        sid_to_client_id.pop(previous_sid, None)
        typing_client_ids.discard(client_id)

    sessions[client_id] = {"sid": request.sid, "nickname": nickname}
    sid_to_client_id[request.sid] = client_id

    emit(
        "join_success",
        {
            "nickname": nickname,
            "history": load_history(),
        },
    )

    if is_new_user:
        socketio.emit(
            "system_message",
            {
                "message": f"{nickname}님이 입장했습니다.",
                "timestamp": current_time(),
            },
        )

    broadcast_user_list()
    broadcast_typing_users()


@socketio.on("send_message")
def handle_send_message(data):
    _client_id, session = current_session()

    if not session:
        emit("chat_error", {"message": "먼저 닉네임을 입력하고 입장해주세요."})
        return

    text = sanitize_text(data.get("text"))
    if not text:
        return

    message = save_message(session["nickname"], "text", text_content=text)
    socketio.emit("new_message", message)


@socketio.on("send_media")
def handle_send_media(data):
    client_id, session = current_session()

    if not session:
        emit("chat_error", {"message": "먼저 닉네임을 입력하고 입장해주세요."})
        return

    raw_media_url = sanitize_text(data.get("media_url"), limit=1000)
    storage_key = sanitize_text(data.get("storage_key"), limit=500)
    media_kind = sanitize_text(data.get("media_kind"), limit=20)
    text = sanitize_text(data.get("text"))

    if not storage_key and raw_media_url.startswith("/uploads/"):
        storage_key = raw_media_url.removeprefix("/uploads/")

    if not storage_key or media_kind not in {"image", "video"}:
        emit("chat_error", {"message": "업로드된 파일 정보를 확인할 수 없습니다."})
        return

    typing_client_ids.discard(client_id)
    message = save_message(
        session["nickname"],
        media_kind,
        text_content=text,
        media_url=storage_key,
        media_kind=media_kind,
    )
    socketio.emit("new_message", message)
    broadcast_typing_users()


@socketio.on("send_gif")
def handle_send_gif(data):
    client_id, session = current_session()

    if not session:
        emit("chat_error", {"message": "먼저 닉네임을 입력하고 입장해주세요."})
        return

    gif_id = sanitize_text(data.get("gif_id"), limit=80)
    gif_title = sanitize_text(data.get("gif_title"), limit=180)
    text = sanitize_text(data.get("text"))

    if not gif_id:
        emit("chat_error", {"message": "GIF 정보를 불러오지 못했습니다."})
        return

    typing_client_ids.discard(client_id)
    message = save_message(
        session["nickname"],
        "gif",
        text_content=text,
        gif_id=gif_id,
        gif_title=gif_title,
    )
    socketio.emit("new_message", message)
    broadcast_typing_users()


@socketio.on("clear_history")
def handle_clear_history():
    _client_id, session = current_session()

    if not session:
        emit("chat_error", {"message": "먼저 채팅방에 입장해주세요."})
        return

    clear_history_store()
    socketio.emit(
        "history_cleared",
        {
            "message": f"{session['nickname']}님이 새 대화를 시작했습니다.",
            "timestamp": current_time(),
        },
    )


@socketio.on("mark_read")
def handle_mark_read(data):
    client_id, session = current_session()

    if not session:
        return

    updates = mark_messages_read(client_id, session["nickname"], data.get("message_ids"))
    if updates:
        socketio.emit("read_updates", {"updates": updates})


@socketio.on("typing")
def handle_typing(data):
    client_id = sid_to_client_id.get(request.sid)
    if client_id not in sessions:
        return

    is_typing = bool(data.get("is_typing"))
    if is_typing:
        typing_client_ids.add(client_id)
    else:
        typing_client_ids.discard(client_id)

    broadcast_typing_users()


@socketio.on("disconnect")
def handle_disconnect():
    client_id = sid_to_client_id.pop(request.sid, None)
    if not client_id:
        return

    session = sessions.get(client_id)
    if not session or session["sid"] != request.sid:
        return

    nickname = session["nickname"]
    sessions.pop(client_id, None)
    typing_client_ids.discard(client_id)

    socketio.emit(
        "system_message",
        {
            "message": f"{nickname}님이 퇴장했습니다.",
            "timestamp": current_time(),
        },
    )
    broadcast_user_list()
    broadcast_typing_users()


init_storage()


if __name__ == "__main__":
    local_ip = get_local_ip()
    storage_mode = "Railway Bucket / S3-compatible storage" if storage_client else "local uploads"
    database_mode = normalize_database_url(DATABASE_URL) if DATABASE_URL else f"sqlite:///{DB_FILE_PATH.as_posix()}"
    print(f"로컬 접속 주소: http://127.0.0.1:{PORT}")
    print(f"같은 와이파이 접속 주소: http://{local_ip}:{PORT}")
    print(f"스토리지 모드: {storage_mode}")
    print(f"데이터베이스 모드: {database_mode}")
    print("인터넷 공유 주소는 실행 중인 Cloudflare Tunnel 링크를 사용하세요.")
    socketio.run(app, host=HOST, port=PORT, debug=False, allow_unsafe_werkzeug=True)
