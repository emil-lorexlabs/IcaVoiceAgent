const button = document.querySelector("#call-button");
const label = document.querySelector("#button-label");
const status = document.querySelector("#status");
const title = document.querySelector("#call-title");
const hint = document.querySelector("#call-hint");
const errorBox = document.querySelector("#error");
const orb = document.querySelector("#voice-orb");
const transcripts = document.querySelector("#transcripts");
const backendUrl = window.ICA_VOICE_AGENT_CONFIG?.backendUrl || "http://localhost:8080";
let activeCall = null;

function agentEndpoints() {
  const base = new URL(`${backendUrl.replace(/\/+$/, "")}/`);
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new Error("Agentens adress i config.js måste börja med http:// eller https://.");
  }
  const voice = new URL("ws/voice", base);
  voice.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return { health: new URL("health", base), voice };
}

function setState(state) {
  document.body.dataset.state = state;
  const live = state === "live";
  const connecting = state === "connecting";
  const stopping = state === "stopping";
  button.disabled = stopping;
  button.setAttribute("aria-pressed", String(live || connecting));
  label.textContent = live || connecting ? "Avsluta samtal" : "Anslut till agenten";
  status.textContent = live ? "Lyssnar" : connecting ? "Ansluter…" : stopping ? "Avslutar…" : "Redo att prata";
  title.textContent = live ? "Jag lyssnar. Vad funderar du på?" : connecting ? "Snart kan vi prata." : "En bra middag börjar med ett samtal.";
  hint.textContent = live ? "Prata som vanligt. Du kan avbryta svaret genom att prata igen." : connecting ? "Tillåt mikrofonen om webbläsaren frågar." : "Tryck på knappen och tillåt mikrofonen.";
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearPlayback(call) {
  for (const source of call.playing) {
    source.onended = null;
    try { source.stop(); } catch { /* Already ended. */ }
    source.disconnect();
  }
  call.playing.clear();
  call.nextPlayTime = 0;
  orb.style.setProperty("--level", "0");
}

async function stopCall(call = activeCall) {
  if (!call || call.stopped) return;
  call.stopped = true;
  if (activeCall === call) setState("stopping");
  clearTimeout(call.timeout);
  call.rejectReady?.(new Error("cancelled"));
  if (call.socket) {
    call.socket.onclose = null;
    call.socket.onmessage = null;
    call.socket.onerror = null;
    call.socket.close();
  }
  if (call.recorder) {
    call.recorder.port.onmessage = null;
    call.recorder.disconnect();
  }
  call.input?.disconnect();
  call.silence?.disconnect();
  call.stream?.getTracks().forEach(track => track.stop());
  clearPlayback(call);
  if (call.context && call.context.state !== "closed") {
    try { await call.context.close(); } catch { /* Context already closed. */ }
  }
  if (activeCall === call) {
    activeCall = null;
    setState("idle");
  }
}

function playAudio(call, data) {
  if (call.stopped || data.byteLength % 2) return;
  const pcm = new DataView(data);
  const audio = call.context.createBuffer(1, data.byteLength / 2, call.outputRate);
  const channel = audio.getChannelData(0);
  for (let i = 0; i < channel.length; i++) channel[i] = pcm.getInt16(i * 2, true) / 32768;
  const source = call.context.createBufferSource();
  source.buffer = audio;
  source.connect(call.context.destination);
  call.playing.add(source);
  const when = Math.max(call.context.currentTime + 0.025, call.nextPlayTime);
  call.nextPlayTime = when + audio.duration;
  status.textContent = "Svarar";
  source.onended = () => {
    source.disconnect();
    call.playing.delete(source);
    if (!call.playing.size && !call.stopped) status.textContent = "Lyssnar";
  };
  source.start(when);
}

function addTranscript(call, message) {
  if (!message.text || !["user", "agent"].includes(message.role)) return;
  document.querySelector("#empty-transcript")?.remove();
  let entry = call.transcriptEntries[message.role];
  if (!entry) {
    const article = document.createElement("article");
    article.className = "transcript";
    article.dataset.role = message.role;
    const name = document.createElement("span");
    name.className = "transcript-label";
    name.textContent = message.role === "user" ? "DU" : "ASSISTENTEN";
    const text = document.createElement("p");
    article.append(name, text);
    transcripts.append(article);
    entry = { text, value: "" };
    call.transcriptEntries[message.role] = entry;
  }
  // Final ADK transcriptions replace the accumulated deltas, avoiding repeats.
  entry.value = message.finished ? message.text : entry.value + message.text;
  entry.text.textContent = entry.value;
  if (message.finished) delete call.transcriptEntries[message.role];
  transcripts.scrollTop = transcripts.scrollHeight;
}

async function startCall() {
  errorBox.hidden = true;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showError("För att kunna använda mikrofonen kräver behöver du ha localhost eller HTTPS.");
    return;
  }
  if (!window.AudioContext || !window.AudioWorkletNode) {
    showError("Din webbläsare saknar ljudstödet som behövs. Prova en aktuell version av Chrome, Edge eller Firefox.");
    return;
  }
  const call = {
    stopped: false, ready: false, playing: new Set(), nextPlayTime: 0,
    outputRate: 24000, transcriptEntries: {},
  };
  activeCall = call;
  setState("connecting");
  try {
    // Resume from the button's click so the browser permits speaker playback.
    call.context = new AudioContext();
    await call.context.resume();
    if (call.stopped) return;

    const endpoints = agentEndpoints();
    let health;
    try {
      health = await fetch(endpoints.health, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new Error("Kunde inte nå Python-agenten. Starta agentens backend och kontrollera adressen i config.js och AGENT_ALLOWED_ORIGINS i .env.");
    }
    if (!health.ok) throw new Error("Python-agenten svarar inte. Försök igen.");
    const configuration = await health.json();
    if (!configuration.configured) throw new Error(configuration.message);
    if (call.stopped) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (call.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
    call.stream = stream;
    await call.context.audioWorklet.addModule(new URL("./pcm-worklet.js", location.href));
    if (call.stopped) return;

    // Create a websocket connection with the server.
    call.socket = new WebSocket(endpoints.voice);
    call.socket.binaryType = "arraybuffer";

    await new Promise((resolve, reject) => {
      call.rejectReady = reject;
      call.timeout = setTimeout(() => reject(new Error("Anslutningen tog för lång tid. Försök igen.")), 15000);
      call.socket.onmessage = event => {
        if (call.stopped) return;

        if (event.data instanceof ArrayBuffer) {
          playAudio(call, event.data);
          return;
        }

        let message;
        try {
          message = JSON.parse(event.data);
        } catch { return; }
        if (message.type === "ready") {
          if (message.input_sample_rate !== 16000) {
            reject(new Error("Servern använder ett oväntat ljudformat."));
            return;
          }
          call.outputRate = message.output_sample_rate;
          call.ready = true;
          clearTimeout(call.timeout);
          call.rejectReady = null;
          resolve();
        } else if (message.type === "error") {
          showError(message.message);
          reject(new Error(message.message));
          void stopCall(call);
        } else if (message.type === "transcript") {
          addTranscript(call, message);
        } else if (message.type === "interrupted") {
          clearPlayback(call);
          call.transcriptEntries = {};
          status.textContent = "Lyssnar";
        } else if (message.type === "turn_complete" && !call.playing.size) {
          status.textContent = "Lyssnar";
        }
      };
      call.socket.onerror = () => {
        const message = "Kunde inte ansluta till Python-agenten. Kontrollera att backend körs och tillåter webbsidans adress.";
        showError(message);
        reject(new Error(message));
        void stopCall(call);
      };
      call.socket.onclose = () => {
        if (!call.stopped) {
          const message = "Samtalet kopplades från. Tryck på Anslut till agenten för att ansluta igen.";
          showError(message);
          reject(new Error(message));
          void stopCall(call);
        }
      };
    });
    if (call.stopped) return;
    call.input = call.context.createMediaStreamSource(stream);
    call.recorder = new AudioWorkletNode(call.context, "pcm-recorder");
    call.silence = call.context.createGain();
    call.silence.gain.value = 0; // Run the worklet without monitoring the mic.
    call.input.connect(call.recorder);
    call.recorder.connect(call.silence);
    call.silence.connect(call.context.destination);
    call.recorder.port.onmessage = event => {
      if (call.stopped || call.socket.readyState !== WebSocket.OPEN) return;
      // Avoid transmitting stale speech if the connection stalls.
      if (call.socket.bufferedAmount > 64000) {
        showError("Anslutningen är för långsam för ett röstsamtal. Försök igen.");
        void stopCall(call);
        return;
      }
      call.socket.send(event.data.pcm);
      orb.style.setProperty("--level", String(Math.min(1, event.data.level * 5)));
    };
    stream.getAudioTracks()[0].onended = () => {
      if (!call.stopped) {
        showError("Mikrofonen kopplades från. Anslut den och starta samtalet igen.");
        void stopCall(call);
      }
    };
    setState("live");
  } catch (error) {
    if (!call.stopped) {
      const messages = {
        NotAllowedError: "Tillåt mikrofonen i webbläsaren och försök igen.",
        NotFoundError: "Ingen mikrofon hittades. Anslut en mikrofon och försök igen.",
        NotReadableError: "Mikrofonen kunde inte öppnas. Kontrollera om en annan app använder den.",
      };
      showError(messages[error.name] || error.message || "Samtalet kunde inte startas. Försök igen.");
    }
    await stopCall(call);
  }
}

button.addEventListener("click", () => { void (activeCall ? stopCall() : startCall()); });
window.addEventListener("pagehide", () => { void stopCall(); });
setState("idle");
