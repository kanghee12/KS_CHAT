const CACHE_NAME = "ks-chat-shell-v2";
const APP_SHELL = [
    "/",
    "/manifest.webmanifest",
    "/static/style.css",
    "/static/script.js",
    "/static/icons/icon-192.png",
    "/static/icons/icon-512.png",
    "/static/icons/icon-180.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== CACHE_NAME)
                        .map((key) => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const { request } = event;

    if (request.method !== "GET") {
        return;
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        return;
    }

    if (url.pathname.startsWith("/socket.io/") || url.pathname.startsWith("/uploads/")) {
        return;
    }

    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put("/", cloned));
                    return response;
                })
                .catch(() => caches.match("/") || Response.error())
        );
        return;
    }

    if (!shouldCache(request, url)) {
        return;
    }

    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            const networkFetch = fetch(request)
                .then((response) => {
                    if (response && response.ok) {
                        const cloned = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
                    }

                    return response;
                })
                .catch(() => cachedResponse);

            return cachedResponse || networkFetch;
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();

    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
            for (const client of clients) {
                if ("focus" in client) {
                    client.navigate("/");
                    return client.focus();
                }
            }

            if (self.clients.openWindow) {
                return self.clients.openWindow("/");
            }

            return undefined;
        })
    );
});

function shouldCache(request, url) {
    return (
        APP_SHELL.includes(url.pathname) ||
        ["script", "style", "image", "font"].includes(request.destination)
    );
}
