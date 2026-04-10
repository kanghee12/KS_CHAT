const socket = io();
const APP_CONFIG = window.APP_CONFIG || {};

const messageList = document.getElementById("messageList");
const userList = document.getElementById("userList");
const onlineCount = document.getElementById("onlineCount");
const connectionStatus = document.getElementById("connectionStatus");
const typingIndicator = document.getElementById("typingIndicator");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const uploadButton = document.getElementById("uploadButton");
const gifButton = document.getElementById("gifButton");
const fileInput = document.getElementById("fileInput");
const uploadStatus = document.getElementById("uploadStatus");
const clearHistoryButton = document.getElementById("clearHistoryButton");
const nicknameModal = document.getElementById("nicknameModal");
const nicknameForm = document.getElementById("nicknameForm");
const nicknameInput = document.getElementById("nicknameInput");
const nicknameError = document.getElementById("nicknameError");
const gifModal = document.getElementById("gifModal");
const closeGifModalButton = document.getElementById("closeGifModalButton");
const gifSearchInput = document.getElementById("gifSearchInput");
const gifSearchButton = document.getElementById("gifSearchButton");
const gifGrid = document.getElementById("gifGrid");
const gifEmptyState = document.getElementById("gifEmptyState");

const clientStorageKey = "ks_chat_client_id";
const nicknameStorageKey = "ks_chat_nickname";

const giphyCache = new Map();
const pendingGifIds = new Set();

let currentNickname = "";
let isTyping = false;
let isUploading = false;
let typingTimer = null;
let gifQueueTimer = null;
let gifSearchTimer = null;
let readQueueTimer = null;

const clientId = getOrCreateClientId();
const savedNickname = sessionStorage.getItem(nicknameStorageKey) || "";

if (savedNickname) {
    nicknameInput.value = savedNickname;
}

showEmptyState("이 대화방은 기록이 남습니다. 새 메시지로 시작해보세요.");
setUploadStatus("전송할 파일이나 GIF를 선택할 수 있어요.");

socket.on("connect", () => {
    updateConnectionStatus(
        currentNickname ? "다시 연결되었습니다. 대화 내용을 복구하는 중..." : "서버에 연결되었습니다.",
        "connected",
    );

    if (currentNickname) {
        emitJoin(currentNickname);
    }
});

socket.on("disconnect", () => {
    setComposerEnabled(false);
    updateConnectionStatus("연결이 끊어졌습니다. 다시 연결을 시도하는 중...", "disconnected");
});

socket.on("join_success", (data) => {
    currentNickname = data.nickname;
    sessionStorage.setItem(nicknameStorageKey, currentNickname);
    nicknameModal.classList.add("hidden");
    nicknameError.textContent = "";
    setComposerEnabled(true);
    updateConnectionStatus("실시간 연결됨", "connected");
    renderHistory(data.history || []);
    queueMarkAllMessagesRead();
    messageInput.focus();
});

socket.on("join_error", (data) => {
    nicknameError.textContent = data.message;
});

socket.on("chat_error", (data) => {
    appendSystemMessage(data.message);
    setUploadStatus(data.message, true);
});

socket.on("new_message", (message) => {
    removeEmptyState();
    appendMessage(message);
    queueMarkAllMessagesRead();
});

socket.on("read_updates", (data) => {
    (data.updates || []).forEach((update) => {
        updateReadReceipt(update.message_id, update.read_by || []);
    });
});

socket.on("system_message", (data) => {
    appendSystemMessage(data.message, data.timestamp);
});

socket.on("history_cleared", (data) => {
    messageList.innerHTML = "";
    showEmptyState("이전 대화가 지워졌습니다. 새로운 대화를 시작해보세요.");
    appendSystemMessage(data.message, data.timestamp);
});

socket.on("user_list", (data) => {
    renderUsers(data.users || []);
    onlineCount.textContent = `${data.count}명 접속 중`;
});

socket.on("typing_users", (data) => {
    renderTypingIndicator(data.users || []);
});

nicknameForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const nickname = nicknameInput.value.trim();
    if (!nickname) {
        nicknameError.textContent = "닉네임을 입력해주세요.";
        return;
    }

    nicknameError.textContent = "";
    updateConnectionStatus("채팅방에 입장하는 중...", "");
    emitJoin(nickname);
});

messageForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const text = messageInput.value.trim();
    if (!currentNickname || !text || isUploading) {
        return;
    }

    socket.emit("send_message", { text });
    messageInput.value = "";
    clearTypingState();
    toggleSendButton();
});

messageInput.addEventListener("input", () => {
    toggleSendButton();

    if (!currentNickname) {
        return;
    }

    const hasText = messageInput.value.trim().length > 0;
    socket.emit("typing", { is_typing: hasText });
    isTyping = hasText;

    clearTimeout(typingTimer);
    if (hasText) {
        typingTimer = window.setTimeout(() => {
            clearTypingState();
        }, 1200);
    }
});

messageInput.addEventListener("blur", () => {
    clearTypingState();
});

messageList.addEventListener("scroll", () => {
    queueMarkAllMessagesRead();
});

window.addEventListener("focus", () => {
    queueMarkAllMessagesRead();
});

document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        queueMarkAllMessagesRead();
    }
});

uploadButton.addEventListener("click", () => {
    if (!currentNickname || isUploading) {
        return;
    }

    fileInput.click();
});

fileInput.addEventListener("change", async (event) => {
    const [selectedFile] = event.target.files || [];
    fileInput.value = "";

    if (!selectedFile) {
        return;
    }

    await uploadSelectedFile(selectedFile);
});

gifButton.addEventListener("click", async () => {
    if (!APP_CONFIG.giphyEnabled) {
        appendSystemMessage("GIPHY 기능을 사용하려면 서버에 GIPHY_API_KEY를 설정해주세요.");
        return;
    }

    gifModal.classList.remove("hidden");
    gifSearchInput.focus();

    if (!gifGrid.children.length) {
        await loadGifResults("");
    }
});

closeGifModalButton.addEventListener("click", closeGifModal);

gifModal.addEventListener("click", (event) => {
    if (event.target === gifModal) {
        closeGifModal();
    }
});

gifSearchButton.addEventListener("click", async () => {
    await loadGifResults(gifSearchInput.value.trim());
});

gifSearchInput.addEventListener("input", () => {
    clearTimeout(gifSearchTimer);
    gifSearchTimer = window.setTimeout(async () => {
        await loadGifResults(gifSearchInput.value.trim());
    }, 350);
});

gifGrid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-gif-id]");
    if (!card || !currentNickname) {
        return;
    }

    const gifId = card.dataset.gifId;
    const cachedGif = giphyCache.get(gifId);
    const gifTitle = cachedGif ? cachedGif.title : "";

    socket.emit("send_gif", {
        gif_id: gifId,
        gif_title: gifTitle,
        text: messageInput.value.trim(),
    });

    messageInput.value = "";
    clearTypingState();
    toggleSendButton();
    closeGifModal();
    setUploadStatus("GIF를 전송했습니다.");
});

clearHistoryButton.addEventListener("click", () => {
    if (!currentNickname) {
        return;
    }

    const confirmed = window.confirm("기존 대화 내용을 모두 지우고 새 대화를 시작할까요?");
    if (!confirmed) {
        return;
    }

    socket.emit("clear_history");
});

function emitJoin(nickname) {
    socket.emit("join", {
        nickname,
        client_id: clientId,
    });
}

function getOrCreateClientId() {
    const existing = sessionStorage.getItem(clientStorageKey);
    if (existing) {
        return existing;
    }

    const nextId =
        window.crypto && typeof window.crypto.randomUUID === "function"
            ? window.crypto.randomUUID()
            : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    sessionStorage.setItem(clientStorageKey, nextId);
    return nextId;
}

function updateConnectionStatus(text, state) {
    connectionStatus.textContent = text;
    connectionStatus.classList.remove("connected", "disconnected");

    if (state) {
        connectionStatus.classList.add(state);
    }
}

function setComposerEnabled(enabled) {
    messageInput.disabled = !enabled;
    uploadButton.disabled = !enabled || isUploading;
    clearHistoryButton.disabled = !enabled;

    if (gifButton) {
        gifButton.disabled = !enabled || !APP_CONFIG.giphyEnabled;
    }

    toggleSendButton();
}

function toggleSendButton() {
    sendButton.disabled = !currentNickname || !messageInput.value.trim() || isUploading;
    uploadButton.disabled = !currentNickname || isUploading;
    clearHistoryButton.disabled = !currentNickname;

    if (gifButton) {
        gifButton.disabled = !currentNickname || !APP_CONFIG.giphyEnabled || isUploading;
    }
}

function clearTypingState() {
    clearTimeout(typingTimer);

    if (!isTyping) {
        return;
    }

    socket.emit("typing", { is_typing: false });
    isTyping = false;
}

function queueMarkAllMessagesRead() {
    if (!currentNickname || document.hidden) {
        return;
    }

    clearTimeout(readQueueTimer);
    readQueueTimer = window.setTimeout(() => {
        markAllMessagesRead();
    }, 120);
}

function markAllMessagesRead() {
    if (!currentNickname || document.hidden) {
        return;
    }

    const messageIds = [...messageList.querySelectorAll("[data-message-id]")]
        .map((node) => Number(node.dataset.messageId))
        .filter((value) => Number.isInteger(value) && value > 0);

    if (!messageIds.length) {
        return;
    }

    socket.emit("mark_read", { message_ids: messageIds });
}

function setUploadStatus(message, isError = false) {
    uploadStatus.textContent = message;
    uploadStatus.classList.toggle("error", isError);
}

async function uploadSelectedFile(file) {
    if (!currentNickname) {
        return;
    }

    const isSupported = file.type.startsWith("image/") || file.type.startsWith("video/");
    if (!isSupported) {
        setUploadStatus("이미지 또는 영상 파일만 전송할 수 있습니다.", true);
        return;
    }

    isUploading = true;
    toggleSendButton();
    setUploadStatus(`${file.name} 업로드 중...`);

    try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("client_id", clientId);

        const response = await fetch("/upload", {
            method: "POST",
            body: formData,
        });
        const payload = await response.json();

        if (!response.ok) {
            throw new Error(payload.message || "파일 업로드에 실패했습니다.");
        }

        socket.emit("send_media", {
            media_url: payload.media_url,
            media_kind: payload.media_kind,
            text: messageInput.value.trim(),
        });

        messageInput.value = "";
        clearTypingState();
        toggleSendButton();
        setUploadStatus(`${file.name} 전송 완료`);
    } catch (error) {
        setUploadStatus(error.message, true);
    } finally {
        isUploading = false;
        toggleSendButton();
    }
}

function renderUsers(users) {
    userList.innerHTML = "";

    users.forEach((nickname) => {
        const item = document.createElement("li");
        item.className = `user-item${nickname === currentNickname ? " self" : ""}`;

        const avatar = document.createElement("div");
        avatar.className = "user-avatar";
        avatar.textContent = nickname.charAt(0).toUpperCase();

        const meta = document.createElement("div");
        meta.className = "user-meta";

        const name = document.createElement("strong");
        name.textContent = nickname;

        const sub = document.createElement("span");
        sub.textContent = nickname === currentNickname ? "나" : "온라인";

        meta.append(name, sub);
        item.append(avatar, meta);
        userList.appendChild(item);
    });
}

function renderTypingIndicator(users) {
    const activeUsers = users.filter((nickname) => nickname !== currentNickname);

    if (activeUsers.length === 0) {
        typingIndicator.textContent = currentNickname
            ? "메시지를 입력해 대화를 이어가보세요."
            : "닉네임을 정하고 대화를 시작해보세요.";
        return;
    }

    if (activeUsers.length === 1) {
        typingIndicator.textContent = `${activeUsers[0]}님이 입력 중입니다...`;
        return;
    }

    if (activeUsers.length === 2) {
        typingIndicator.textContent = `${activeUsers[0]}님과 ${activeUsers[1]}님이 입력 중입니다...`;
        return;
    }

    typingIndicator.textContent = `${activeUsers[0]}님 외 ${activeUsers.length - 1}명이 입력 중입니다...`;
}

function renderHistory(messages) {
    messageList.innerHTML = "";

    if (!messages.length) {
        showEmptyState("기존 대화가 없습니다. 새로운 메시지로 시작해보세요.");
        return;
    }

    messages.forEach((message) => {
        appendMessage(message, false);
    });

    hydrateQueuedGifs();
    scrollMessagesToBottom();
}

function appendMessage(message, shouldScroll = true) {
    const row = buildMessageRow(message);
    messageList.appendChild(row);

    if (message.type === "gif") {
        queueGifHydration(message.gif_id);
    }

    if (shouldScroll) {
        scrollMessagesToBottom();
    }
}

function buildMessageRow(message) {
    const row = document.createElement("article");
    row.className = `message-row${message.nickname === currentNickname ? " self" : ""}`;
    row.dataset.messageId = message.id;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = message.nickname.charAt(0).toUpperCase();

    const body = document.createElement("div");
    body.className = "message-body";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const name = document.createElement("strong");
    name.textContent = message.nickname;

    const time = document.createElement("span");
    time.textContent = message.timestamp;

    const card = document.createElement("div");
    card.className = "message-card";

    meta.append(name, time);
    body.append(meta, card);

    if (message.type === "text") {
        card.appendChild(createTextBlock(message.text));
    } else if (message.type === "image") {
        card.appendChild(createImageBlock(message.media_url));

        if (message.text) {
            card.appendChild(createCaptionBlock(message.text));
        }
    } else if (message.type === "video") {
        card.appendChild(createVideoBlock(message.media_url));

        if (message.text) {
            card.appendChild(createCaptionBlock(message.text));
        }
    } else if (message.type === "gif") {
        card.appendChild(createGifBlock(message));

        if (message.text) {
            card.appendChild(createCaptionBlock(message.text));
        }
    }

    if (message.nickname === currentNickname) {
        card.appendChild(createReadReceipt(message));
    }

    row.append(avatar, body);
    return row;
}

function createTextBlock(text) {
    const paragraph = document.createElement("p");
    paragraph.className = "message-text";
    paragraph.textContent = text;
    return paragraph;
}

function createCaptionBlock(text) {
    const paragraph = document.createElement("p");
    paragraph.className = "message-caption";
    paragraph.textContent = text;
    return paragraph;
}

function createImageBlock(mediaUrl) {
    const frame = document.createElement("div");
    frame.className = "media-frame";

    const image = document.createElement("img");
    image.className = "media-content";
    image.src = mediaUrl;
    image.alt = "전송된 이미지";
    image.loading = "lazy";

    frame.appendChild(image);
    return frame;
}

function createVideoBlock(mediaUrl) {
    const frame = document.createElement("div");
    frame.className = "media-frame";

    const video = document.createElement("video");
    video.className = "media-content";
    video.src = mediaUrl;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;

    frame.appendChild(video);
    return frame;
}

function createGifBlock(message) {
    const frame = document.createElement("div");
    frame.className = "gif-frame";
    frame.dataset.gifId = message.gif_id;
    frame.innerHTML = '<div class="gif-loading">GIF 불러오는 중...</div>';

    const cached = giphyCache.get(message.gif_id);
    if (cached) {
        populateGifFrame(frame, cached);
    }

    return frame;
}

function createReadReceipt(message) {
    const receipt = document.createElement("div");
    receipt.className = "read-receipt";
    receipt.dataset.messageId = message.id;
    receipt.textContent = formatReadReceipt(message.read_by || []);
    return receipt;
}

function updateReadReceipt(messageId, readers) {
    const receipt = messageList.querySelector(`.read-receipt[data-message-id="${messageId}"]`);
    if (!receipt) {
        return;
    }

    receipt.textContent = formatReadReceipt(readers);
}

function formatReadReceipt(readers) {
    if (!readers || !readers.length) {
        return "아직 읽지 않음";
    }

    if (readers.length === 1) {
        return `읽음 · ${readers[0]}`;
    }

    if (readers.length === 2) {
        return `읽음 · ${readers[0]}, ${readers[1]}`;
    }

    return `읽음 · ${readers[0]}, ${readers[1]} 외 ${readers.length - 2}명`;
}

function appendSystemMessage(message, timestamp = "") {
    const row = document.createElement("div");
    row.className = "message-row system";

    const bubble = document.createElement("div");
    bubble.className = "system-bubble";
    bubble.textContent = timestamp ? `${message} · ${timestamp}` : message;

    row.appendChild(bubble);
    messageList.appendChild(row);
    scrollMessagesToBottom();
}

function showEmptyState(message) {
    removeEmptyState();

    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.id = "emptyState";
    empty.textContent = message;
    messageList.appendChild(empty);
}

function removeEmptyState() {
    const emptyState = document.getElementById("emptyState");
    if (emptyState) {
        emptyState.remove();
    }
}

function scrollMessagesToBottom() {
    messageList.scrollTop = messageList.scrollHeight;
}

function closeGifModal() {
    gifModal.classList.add("hidden");
}

async function loadGifResults(query) {
    if (!APP_CONFIG.giphyEnabled) {
        gifEmptyState.textContent = "GIPHY API 키가 설정되지 않았습니다.";
        gifGrid.innerHTML = "";
        return;
    }

    gifEmptyState.textContent = "GIF를 불러오는 중입니다...";
    gifEmptyState.classList.remove("hidden");
    gifGrid.innerHTML = "";

    try {
        const params = new URLSearchParams({
            api_key: APP_CONFIG.giphyApiKey,
            limit: "18",
            rating: "g",
            lang: "ko",
        });

        let endpoint = "https://api.giphy.com/v1/gifs/trending";
        if (query) {
            endpoint = "https://api.giphy.com/v1/gifs/search";
            params.set("q", query);
        }

        const response = await fetch(`${endpoint}?${params.toString()}`);
        const payload = await response.json();

        if (!response.ok) {
            throw new Error("GIPHY 결과를 불러오지 못했습니다.");
        }

        const gifs = payload.data || [];
        if (!gifs.length) {
            gifEmptyState.textContent = "검색 결과가 없습니다.";
            return;
        }

        gifs.forEach((gif) => {
            giphyCache.set(gif.id, normalizeGif(gif));
            gifGrid.appendChild(createGifCard(gif));
        });

        gifEmptyState.classList.add("hidden");
    } catch (error) {
        gifGrid.innerHTML = "";
        gifEmptyState.textContent = error.message;
    }
}

function createGifCard(gif) {
    const button = document.createElement("button");
    button.className = "gif-card";
    button.type = "button";
    button.dataset.gifId = gif.id;

    const image = document.createElement("img");
    image.loading = "lazy";
    image.alt = gif.title || "GIF";
    image.src = pickFirst([
        getGifValue(gif, "fixed_width", "webp"),
        getGifValue(gif, "fixed_width", "url"),
        getGifValue(gif, "preview_gif", "url"),
        getGifValue(gif, "original", "url"),
    ]);

    const label = document.createElement("span");
    label.textContent = "보내기";

    button.append(image, label);
    return button;
}

function normalizeGif(gif) {
    return {
        id: gif.id,
        title: gif.title || "GIF",
        imageUrl: pickFirst([
            getGifValue(gif, "original", "webp"),
            getGifValue(gif, "original", "url"),
            getGifValue(gif, "fixed_width", "url"),
        ]),
        mp4Url: pickFirst([
            getGifValue(gif, "original", "mp4"),
            getGifValue(gif, "fixed_width", "mp4"),
        ]),
    };
}

function pickFirst(values) {
    return values.find(Boolean) || "";
}

function getGifValue(gif, imageSet, field) {
    if (!gif || !gif.images || !gif.images[imageSet]) {
        return "";
    }

    return gif.images[imageSet][field] || "";
}

function queueGifHydration(gifId) {
    if (!gifId || giphyCache.has(gifId) || !APP_CONFIG.giphyEnabled) {
        hydrateQueuedGifs();
        return;
    }

    pendingGifIds.add(gifId);
    clearTimeout(gifQueueTimer);
    gifQueueTimer = window.setTimeout(fetchQueuedGifs, 160);
}

async function fetchQueuedGifs() {
    if (!pendingGifIds.size || !APP_CONFIG.giphyEnabled) {
        return;
    }

    const ids = [...pendingGifIds].slice(0, 100);
    ids.forEach((id) => pendingGifIds.delete(id));

    try {
        const params = new URLSearchParams({
            api_key: APP_CONFIG.giphyApiKey,
            ids: ids.join(","),
            rating: "g",
        });

        const response = await fetch(`https://api.giphy.com/v1/gifs?${params.toString()}`);
        const payload = await response.json();

        if (!response.ok) {
            throw new Error("GIF 정보를 불러오지 못했습니다.");
        }

        (payload.data || []).forEach((gif) => {
            giphyCache.set(gif.id, normalizeGif(gif));
        });
    } catch (_error) {
        // Keep the placeholder visible when GIPHY metadata cannot be loaded.
    }

    hydrateQueuedGifs();

    if (pendingGifIds.size) {
        clearTimeout(gifQueueTimer);
        gifQueueTimer = window.setTimeout(fetchQueuedGifs, 160);
    }
}

function hydrateQueuedGifs() {
    const gifFrames = messageList.querySelectorAll(".gif-frame[data-gif-id]");
    gifFrames.forEach((frame) => {
        const gifId = frame.dataset.gifId;
        const gif = giphyCache.get(gifId);

        if (gif) {
            populateGifFrame(frame, gif);
            return;
        }

        if (!APP_CONFIG.giphyEnabled) {
            frame.innerHTML = '<div class="gif-loading">GIPHY API 키가 필요합니다.</div>';
        }
    });
}

function populateGifFrame(frame, gif) {
    frame.innerHTML = "";

    if (gif.mp4Url) {
        const video = document.createElement("video");
        video.className = "media-content";
        video.src = gif.mp4Url;
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        frame.appendChild(video);
        return;
    }

    const image = document.createElement("img");
    image.className = "media-content";
    image.src = gif.imageUrl;
    image.alt = gif.title;
    image.loading = "lazy";
    frame.appendChild(image);
}
