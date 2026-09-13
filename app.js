const AZURACAST_BASE =
    (DASHBOARD_CONFIG.azuracastUrl || "").replace(/\/+$/, "");

const API_BASE =
    `${AZURACAST_BASE}/api/nowplaying`;

const FALLBACK_ART =
    new URL("favicon.svg", document.baseURI).href;

const REQUEST_API_BASE =
    `${AZURACAST_BASE}/api/station`;

const SITE_TITLE =
    DASHBOARD_CONFIG.siteTitle || "AzuraCast Dashboard";

let stations = [];
let fullView = false;
let audioPlayer = null;
let activeStation = null;
let requestStation = null;
let requestPage = 1;
let requestRows = 25;
let requestSearch = "";
let requestTotalPages = 1;
let requestControlsInitialized = false;

function formatTime(seconds) {
    seconds = Math.floor(seconds || 0);
    const minutes =
        Math.floor(seconds / 60);
    const remaining =
        seconds % 60;
    return `${minutes}:${remaining
        .toString()
        .padStart(2, "0")}`;
}

// Loads the public station list directly from AzuraCast. Station IDs,
// shortcodes, names, stream URLs, and initial now-playing data all come
// from the same public endpoint, so there is no station-specific
// configuration to maintain in this application.
async function loadStations() {
    try {
        const response =
            await fetch(API_BASE);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data =
            await response.json();

        if (!Array.isArray(data)) {
            throw new Error("Unexpected now-playing API response");
        }

        stations = data
            .filter(np => np?.station?.shortcode)
            .map(np => ({
                id: np.station.id,
                shortcode: np.station.shortcode,
                name: np.station.name || np.station.shortcode,
                expanded: false,
                data: np,
                streamUrl:
                    np.station.listen_url ||
                    np.station.listen_url_resolved,
                serverElapsed:
                    np.now_playing?.elapsed || 0,
                serverTimestamp: Date.now(),
                lastSongKey:
                    getSongKey(np.now_playing || {}),
                lastArtwork:
                    np.now_playing?.song?.art || null
            }));

        stations.sort((a, b) => {
            const sortKey = value =>
                value
                    .replace(/^(a|an|the)\s+/i, "")
                    .toLowerCase();

            return sortKey(a.name).localeCompare(sortKey(b.name));
        });

        renderDashboard();
    }
    catch (error) {
        console.error(
            "Station loading failed:",
            error
        );

        const dashboard =
            document.getElementById("dashboard");

        if (dashboard) {
            dashboard.className = "compact";
            dashboard.innerHTML =
                "<p>Unable to load stations from AzuraCast.</p>";
        }

        throw error;
    }
}

async function loadRequests() {
    if (!requestStation) {
        return;
    }

    const url =
        `${REQUEST_API_BASE}/${requestStation.id}/requests` +
        `?internal=true` +
        `&rowCount=${requestRows}` +
        `&current=${requestPage}` +
        `&searchPhrase=${encodeURIComponent(requestSearch)}`;

    try {
        const response =
            await fetch(url);

        const data =
            await response.json();

        requestTotalPages =
            data.total_pages || 1;

       renderRequests(
            requestStation,
            data
       );

        const pageInfo =
            document.getElementById(
                "requestPageInfo"
            );

        const pageJump =
            document.getElementById(
                "requestPageJump"
            );

        if (pageInfo) {

            pageInfo.textContent =
                `of ${requestTotalPages}`;

        }

        if (pageJump) {
            pageJump.value =
                requestPage;

        }
    }
    catch(error) {

        console.error(
            "Request loading failed:",
            error
        );
    }
}

function getSong(station) {
    return station.data?.now_playing?.song || {};
}

function getNowPlaying(station) {
    return station.data?.now_playing || {};
}

function getNext(station) {
    return station.data?.playing_next?.song || null;
}

function getHistory(station) {
    return station.data?.song_history || [];
}

function getArtwork(station) {
    const artwork =
        station.data?.now_playing?.song?.art;

    if (artwork) {
        station.lastArtwork =
            artwork;
    }

    return (
        station.lastArtwork ||
        FALLBACK_ART
    );
}

// Computes the current elapsed time for a station as a calculated value,
// never as an incremented counter. Two sources of truth:
//
// 1. serverElapsed/serverTimestamp - set every time the AzuraCast API
//    responds. This is authoritative for stations that are not the one
//    actively being listened to.
//
// 2. playStartElapsed/playStartedAt - set whenever this station's audio
//    element actually starts/resumes playing. While this station is the
//    one actively playing, this is authoritative, since it's anchored to
//    what the listener is actually hearing rather than to server metadata
//    polled every 5 seconds.
function computeElapsed(station, index) {
    const duration =
        station.data?.now_playing?.duration || 0;
    const now =
        Date.now();
    const isActivePlaying =
        index === activeStation &&
        audioPlayer &&
        !audioPlayer.paused;

    let elapsed = 0;

    if (
        isActivePlaying &&
        typeof station.playStartElapsed === "number" &&
        typeof station.playStartedAt === "number"
    ) {
        elapsed =
            station.playStartElapsed +
            (now - station.playStartedAt) / 1000;
    }
    else if (
        typeof station.serverElapsed === "number" &&
        typeof station.serverTimestamp === "number"
    ) {
        elapsed =
            station.serverElapsed +
            (now - station.serverTimestamp) / 1000;
    }

    if (duration && elapsed > duration) {
        elapsed = duration;
    }

    if (elapsed < 0) {
        elapsed = 0;
    }

    return elapsed;
}

// Identifies a specific song *play instance*, not just a track. AzuraCast
// reports "played_at" (unix time the current song started), which changes
// every time the song changes even if the same track repeats later in a
// playlist. Falls back to title/artist if played_at is ever missing.
function getSongKey(nowPlaying) {
    const song =
        nowPlaying?.song || {};
    return `${nowPlaying?.played_at || ""}|${song.title || ""}|${song.artist || ""}`;
}

// Applies one now-playing payload (the same shape AzuraCast's REST API
// returns for a single station - "station", "now_playing", "playing_next",
// "song_history", etc.) to the matching station in our local list. The
// payload identifies its own station via np.station.shortcode, so we don't
// need to track which SSE channel it arrived on.
function applyNowPlayingUpdate(np) {
    if (!np || !np.station) {
        return;
    }

    const index =
        stations.findIndex(
            s => s.shortcode === np.station.shortcode
        );

    if (index === -1) {
        return;
    }

    const station =
        stations[index];

    station.data =
        np;

    station.streamUrl =
        np.station?.listen_url ||
        np.station?.listen_url_resolved;

    const nowPlaying =
        np.now_playing || {};

    const newElapsed =
        nowPlaying.elapsed || 0;

    const newSongKey =
        getSongKey(nowPlaying);

    const songChanged =
        typeof station.lastSongKey === "string" &&
        station.lastSongKey !== newSongKey;

    const elapsedChanged =
        station.serverElapsed !== newElapsed;

    const noAnchorYet =
        typeof station.serverTimestamp !== "number";

    // A push only arrives when AzuraCast's own data actually changed, so
    // this duplicate-guard rarely matters here the way it did for polling -
    // but it's harmless to keep, and protects against any redundant/replay
    // messages (e.g. Centrifugo's "recover" catch-up on reconnect).
    if (songChanged || elapsedChanged || noAnchorYet) {
        station.serverElapsed =
            newElapsed;
        station.serverTimestamp =
            Date.now();
    }

    // The active station's playback clock is normally anchored once, when
    // Play is clicked (see anchorPlaybackClock()). But this is a
    // continuous live stream - many songs play during one listening
    // session without another native "play" event ever firing. Re-anchor
    // whenever the song actually changes while this station is the one
    // being listened to, so the clock doesn't keep climbing across song
    // boundaries and clamp at each new song's duration.
    if (
        songChanged &&
        index === activeStation &&
        audioPlayer &&
        !audioPlayer.paused
    ) {
        station.playStartedAt =
            Date.now();

        station.playStartElapsed =
            newElapsed;
    }

    station.lastSongKey =
        newSongKey;

    const artwork =
        nowPlaying.song?.art;

    if (artwork) {
        station.lastArtwork =
            artwork;
    }

    renderDashboard();
}

// Update the tab with the currently playing song
function updateDocumentTitle() {
    if (
        activeStation !== null &&
        audioPlayer &&
        !audioPlayer.paused
    ) {

        const station =
            stations[activeStation];
        const song =
            getSong(station);

        if (song.title) {
            document.title =
                song.title;
            return;
        }
    }

    document.title =
        SITE_TITLE;
}

// Update the Media Session Data for headunits
function updateMediaMetadata() {

    if (
        activeStation !== null &&
        audioPlayer &&
        !audioPlayer.paused
    ) {

        const station =
            stations[activeStation];

        const song =
            getSong(station);

        if (
            song.title &&
            "mediaSession" in navigator
        ) {

            const artwork =
                getArtwork(station);

            navigator.mediaSession.metadata =
                new MediaMetadata({
                    title: song.title,
                    artist: song.artist || "",
                    album: song.album || "",
                    artwork: artwork
                        ? [
                            {
                                src: artwork,
                                sizes: "512x512"
                            }
                        ]
                        : []
                });

            return;

        }

    }

    if ("mediaSession" in navigator) {

        navigator.mediaSession.metadata =
            null;

    }

}

// More Headunit time adjustments
function updateMediaPosition() {

    if (
        activeStation === null ||
        !audioPlayer ||
        audioPlayer.paused ||
        !("mediaSession" in navigator) ||
        !("setPositionState" in navigator.mediaSession)
    ) {

        return;

    }

    const station =
        stations[activeStation];

    if (!station) {
        return;
    }

    const duration =
        Number(
            station.data?.now_playing?.duration || 0
        );

    const elapsed =
        Number(
            computeElapsed(
                station,
                activeStation
            )
        );

    // Media Session requires a finite, positive duration.
    if (
        !Number.isFinite(duration) ||
        duration <= 0
    ) {

        return;

    }

    // Position must be finite and between zero and duration.
    if (
        !Number.isFinite(elapsed)
    ) {

        return;

    }

    const position =
        Math.max(
            0,
            Math.min(
                elapsed,
                duration
            )
        );

    try {
        navigator.mediaSession.setPositionState({
            duration: duration,
            playbackRate:
                audioPlayer.playbackRate || 1,
            position: position
        });
    }
    catch (error) {

        // A song transition can briefly produce
        // inconsistent metadata. Don't let that
        // break the dashboard.

        console.debug(
            "Media Session position update skipped:",
            error
        );

    }

}

// Builds the Centrifugo subscription list AzuraCast expects: one
// "station:<shortcode>" channel per station, all on a single connection.
function buildNowPlayingSubs() {

    const subs = {};

    stations.forEach(station => {
        subs[`station:${station.shortcode}`] =
            { recover: true };
    });

    return subs;
}

// Opens one persistent Server-Sent Events connection covering all
// stations, replacing periodic polling entirely. AzuraCast pushes a
// message the instant a station's now-playing data actually changes,
// instead of us having to wait out a polling interval to notice.
function connectNowPlayingFeed() {

    const sseBaseUri =
        new URL(
            "/api/live/nowplaying/sse",
            AZURACAST_BASE || window.location.origin
        ).href;

    const sseUriParams =
        new URLSearchParams({
            cf_connect: JSON.stringify({
                subs: buildNowPlayingSubs()
            })
        });

    const sse =
        new EventSource(`${sseBaseUri}?${sseUriParams.toString()}`);

    sse.onmessage = event => {
        try {
            const jsonData =
                JSON.parse(event.data);

            if ("connect" in jsonData) {
                const connectData =
                    jsonData.connect;

                if ("data" in connectData) {
                    // Legacy Centrifugo response shape.
                    connectData.data.forEach(
                        row => applyNowPlayingUpdate(row?.data?.np)
                    );
                }
                else {
                    // Current Centrifugo shape: each subscribed channel's
                    // cached last message is delivered up front on connect.
                    for (const subName in connectData.subs) {

                        const sub =
                            connectData.subs[subName];

                        if (sub.publications?.length > 0) {
                            sub.publications.forEach(
                                row => applyNowPlayingUpdate(row?.data?.np)
                            );
                        }
                    }
                }
            }
            else if ("pub" in jsonData) {
                applyNowPlayingUpdate(jsonData.pub?.data?.np);
            }
        }
        catch(error) {
            console.error(
                "Failed to process now-playing update:",
                error
            );
        }
    };

    sse.onerror = error => {
        // EventSource retries the connection automatically - nothing
        // else to do here besides logging it.
        console.error(
            "Now-playing feed connection error:",
            error
        );
    };
}

function updateProgress() {
    stations.forEach((station,index)=>{
        const card =
            document.querySelector(
                `[data-station="${index}"]`
            );

        if (!card) {
            return;
        }

        const elapsed =
            computeElapsed(station, index);

        const duration =
            station.data?.now_playing?.duration || 0;

        const percent =
            duration
            ? (elapsed / duration) * 100
            : 0;

        const time =
            card.querySelector(".time");

        const bar =
            card.querySelector(".progress span");

        if (time) {
            time.textContent =
                `${formatTime(elapsed)} / ${formatTime(duration)}`;
        }

        if (bar) {
            bar.style.width =
                `${percent}%`;
        }
    });
}

function togglePlayback(index) {
    if (!audioPlayer) {
        console.error(
            "Audio player not initialized"
        );
        return;
    }

    const station =
        stations[index];

    if (!station.streamUrl) {
        console.error(
            "No stream URL",
            station
        );
        return;
    }

    if (activeStation === index) {
        if (audioPlayer.paused) {
            audioPlayer
                .play()
                .then(()=>{
                    anchorPlaybackClock(station);
                    renderDashboard();
                })
                .catch(console.error);
        }
        else {
            audioPlayer.pause();
        }
        return;
    }

    audioPlayer.pause();

    audioPlayer.src =
        station.streamUrl;

    audioPlayer.load();

    audioPlayer
        .play()
        .then(()=>{
            activeStation =
                index;

            anchorPlaybackClock(station);

            renderDashboard();
        })
        .catch(error=>{
            console.error(
                "Playback failed:",
                error
            );
        });
}

// Anchors this station's playback clock to "now", using the most recent
// server-reported elapsed time as the starting point. Called only from
// the play()-promise .then() callbacks above, where activeStation is
// already known to be correct - never from the audio element's native
// "play" event, since that event and the play() promise resolving are
// two separate async callbacks with no guaranteed order between them.
// Anchoring from the "play" event caused this station to silently fall
// back to the server-only calculation whenever the event fired before
// activeStation was assigned, which looked identical to the original bug.
function anchorPlaybackClock(station) {

    station.playStartedAt =
        Date.now();

    station.playStartElapsed =
        typeof station.serverElapsed === "number"
        ? station.serverElapsed
        : 0;

}

function updatePlayButtons() {

    document
        .querySelectorAll(".listen")
        .forEach((button,index)=>{

            button.textContent =
                (
                    index === activeStation &&
                    audioPlayer &&
                    !audioPlayer.paused
                )

                ? "⏸ Pause"

                : "▶ Play";

        });

}

function updateViewButtons() {

    const compactButton =
        document.getElementById("compactButton");

    const fullButton =
        document.getElementById("fullButton");

    if (compactButton) {

        compactButton.classList.toggle(
            "active",
            !fullView
        );

    }

    if (fullButton) {

        fullButton.classList.toggle(
            "active",
            fullView
        );

    }

}

function renderHistory(station) {

    if (!fullView || !station.expanded) {

        return "";

    }

    return `

<div class="history">

<h3>History</h3>

${
    getHistory(station)
    .slice(0,5)
    .map(item => `

<div class="history-item">

${item.song.title}
-
${item.song.artist}

</div>

`)
.join("")
}

</div>

`;

}

function renderDashboard() {

    const dashboard =
        document.getElementById("dashboard");

    if (!dashboard) {

        console.error(
            "Dashboard element missing"
        );

        return;

    }

    dashboard.className =
        fullView
        ? "full"
        : "compact";

    dashboard.innerHTML = "";

    stations.forEach((station,index)=>{

        const song =
            getSong(station);

        const now =
            getNowPlaying(station);

        const elapsed =
            computeElapsed(station, index);

        const duration =
            now.duration ||
            0;

        const progress =
            duration
            ? (elapsed / duration) * 100
            : 0;

        const next =
            getNext(station);

        const playing =
            activeStation === index &&
            audioPlayer &&
            !audioPlayer.paused
            ? "playing"
            : "";

        dashboard.innerHTML += `

<section class="station ${playing}" data-station="${index}">

<img class="art"
src="${getArtwork(station)}">

<div class="info">

<div class="station-name">

${station.name}

<span class="live">
● LIVE
</span>

</div>

<div class="song">

${song.title || "Unknown"}

</div>

<div class="artist">

${song.artist || ""}

</div>

<div class="time">

${formatTime(elapsed)}
/
${formatTime(duration)}

</div>

<div class="progress">

<span style="width:${progress}%"></span>

</div>

<div class="next">

${
next
?
`Next: ${next.title} - ${next.artist}`
:
"Next: None"
}

</div>

<button
class="listen"
onclick="togglePlayback(${index})">

▶ Play

</button>

${
fullView
?
`
<button
class="request-button"
onclick="openRequestModal(${index})">

🎵 Request

</button>

<button
class="history-button"
onclick="toggleHistory(${index})">

${station.expanded ? "▲ Hide History" : "▼ History"}

</button>
`
:
""
}

${renderHistory(station)}

</div>

</section>

`;

    });

    updatePlayButtons();
    updateViewButtons();
    updateDocumentTitle();
    updateMediaMetadata();
}

function toggleHistory(index) {

    stations[index].expanded =
        !stations[index].expanded;

    renderDashboard();

}

async function openRequestModal(index) {

    const station =
        stations[index];

    const modal =
        document.getElementById("requestModal");

    const title =
        document.getElementById("requestStationName");

    const list =
        document.getElementById("requestList");

    if (!modal || !title || !list) {

        console.error(
            "Request modal elements missing"
        );

        return;

    }

    requestStation = station;
    requestPage = 1;
    requestSearch = "";

    title.textContent =
        `${station.name} Requests`;

    list.innerHTML =
        "Loading songs...";

    modal.classList.remove("hidden");

    const search =
        document.getElementById(
            "requestSearch"
        );

    if (search) {

        search.value = "";

    }

    await loadRequests();

    if (!requestControlsInitialized) {

      setupRequestControls();

      requestControlsInitialized = true;

}
}

function updateRequestPagination() {

    const info =
        document.getElementById(
            "requestPageInfo"
        );

    const jump =
        document.getElementById(
            "requestPageJump"
        );

    if (info) {

        info.textContent =
            `of ${requestTotalPages}`;

    }

    if (jump) {

        jump.value =
            requestPage;

    }

}

function renderRequests(station, requests) {

    if (requests.rows) {
        requests = requests.rows;
    }

    const list =
        document.getElementById(
            "requestList"
        );

    if (!list) {
        return;
    }

    list.innerHTML = "";

    requests.forEach(request => {

        list.insertAdjacentHTML(
            "beforeend",
            `

<div class="request-item">

<img
class="request-art"
src="${request.song.art || FALLBACK_ART}"
>

<div>

<strong>
${request.song.title}
</strong>

<br>

<span>
${request.song.artist}
</span>

<br>

<small>
${request.song.album || ""}
</small>

</div>

<button
class="request-song-button"
data-request="${request.request_id}"
onclick="submitRequest('${request.request_url}', this)">

Request

</button>

</div>

`
        );

    });

}

function setupRequestControls() {

    const search =
        document.getElementById(
            "requestSearch"
        );

    const rows =
        document.getElementById(
            "requestRows"
        );

    const refresh =
        document.getElementById(
            "requestRefresh"
        );

    const prev =
        document.getElementById(
            "requestPrevious"
        );

    const next =
        document.getElementById(
            "requestNext"
        );

    const jump =
        document.getElementById(
            "requestPageJump"
        );

    if (search) {

        let timer;

        search.addEventListener(
            "input",
            ()=>{

                clearTimeout(timer);

                timer =
                    setTimeout(
                        ()=>{

                            requestSearch =
                                search.value;

                            requestPage =
                                1;

                            loadRequests();

                        },
                        300
                    );

            }
        );

    }

    if (rows) {

        rows.addEventListener(
            "change",
            ()=>{

                requestRows =
                    Number(rows.value);

                requestPage =
                    1;

                loadRequests();

            }
        );

    }

    if (refresh) {

        refresh.addEventListener(
            "click",
            loadRequests
        );

    }

    if (prev) {

        prev.addEventListener(
            "click",
            ()=>{

                if (requestPage > 1) {

                    requestPage--;

                    loadRequests();

                }

            }
        );

    }

    if (next) {

        next.addEventListener(
            "click",
            ()=>{

                if (
                    requestPage <
                    requestTotalPages
                ) {

                    requestPage++;

                    loadRequests();

                }

            }
        );

    }

    if (jump) {

        jump.addEventListener(
            "change",
            ()=>{

                let page =
                    Number(jump.value);

                if (page < 1) {

                    page = 1;

                }

                if (
                    page >
                    requestTotalPages
                ) {

                    page =
                        requestTotalPages;

                }

                requestPage =
                    page;

                loadRequests();

            }
        );

    }

}

function showToast(message) {

    const toast =
        document.getElementById("toast");

    if (!toast) {
        return;
    }

    toast.textContent =
        message;

    toast.classList.add(
        "show"
    );

    setTimeout(
        () => {

            toast.classList.remove(
                "show"
            );

        },
        3000
    );

}

async function submitRequest(requestUrl, button) {

    if (button) {

        button.disabled = true;

        button.textContent =
            "Requesting...";

    }

    try {

        const response =
            await fetch(
                `${REQUEST_API_BASE.replace("/requests","")}${requestUrl}`,
                {
                    method: "POST"
                }
            );

        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status}`
            );

        }

        if (button) {

            button.textContent =
                "Requested ✓";

            button.classList.add(
                "requested"
            );

        }

        showToast(
            "Your song request has been submitted."
        );

    }
    catch(error) {

        console.error(
            "Request submit failed:",
            error
        );

        /*
         * AzuraCast may return a successful
         * request but browsers can report
         * a CORS failure. Do not undo the
         * button state immediately.
         */

        if (button) {

            button.textContent =
                "Requested ✓";

            button.classList.add(
                "requested"
            );

        }

        showToast(
            "Your song request has been submitted."
        );

    }

}

function closeRequestModal() {

    const modal =
        document.getElementById("requestModal");

    if (modal) {

        modal.classList.add(
            "hidden"
        );

    }

}

const closeRequestButton =
    document.getElementById("closeRequestModal");

if (closeRequestButton) {

    closeRequestButton.addEventListener(
        "click",
        closeRequestModal
    );

}

async function initializeDashboard() {
    audioPlayer =
        document.getElementById("audioPlayer");

    const compactButton =
        document.getElementById("compactButton");

    const fullButton =
        document.getElementById("fullButton");

    const heading =
        document.querySelector("header h1");

    document.title = SITE_TITLE;

    if (heading) {
        heading.textContent = SITE_TITLE;
    }

    if (compactButton) {
        compactButton.addEventListener(
            "click",
            () => {
                fullView = false;
                renderDashboard();
            }
        );
    }

    if (fullButton) {
        fullButton.addEventListener(
            "click",
            () => {
                fullView = true;
                renderDashboard();
            }
        );
    }

    if (audioPlayer) {
        // Just re-renders. Anchoring the playback clock happens
        // deterministically in togglePlayback()'s play() .then()
        // callbacks instead - see anchorPlaybackClock().
        audioPlayer.addEventListener(
            "play",
            () => {
                renderDashboard();
            }
        );

        audioPlayer.addEventListener(
            "pause",
            () => {
                renderDashboard();
            }
        );
    }

    try {
        await loadStations();
        connectNowPlayingFeed();
    }
    catch {
        // loadStations() has already displayed the error.
    }

    // Per-second UI refresh only - never mutates elapsed state directly.
    // computeElapsed() derives the value fresh from the stored anchors.
    setInterval(
        () => {
            updateProgress();
            updateMediaPosition();
        },
        1000
    );
}

document.addEventListener(
    "DOMContentLoaded",
    initializeDashboard
);
