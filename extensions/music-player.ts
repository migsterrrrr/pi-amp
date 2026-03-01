/**
 * pi-amp — CLI music player extension for pi
 *
 * Commands: /play <query>, /pause, /stop, /np, /vol <0-100>
 * Shows now-playing in status bar. LLM can use the play_music tool.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const IPC_SOCKET = "/tmp/mpv-pi-player.sock";
let mpvProcess: ChildProcess | null = null;
let currentTrack = { title: "", artist: "", duration: "", url: "" };
let isPlaying = false;
let statusCtx: any = null;
let queue: { title: string; url: string }[] = [];

// --- Dependency checking ---

function which(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function checkDeps(ctx: any): boolean {
	const missing: string[] = [];

	if (!which("mpv")) missing.push("mpv (sudo apt install mpv)");
	if (!which("yt-dlp")) missing.push("yt-dlp (pip install yt-dlp or https://github.com/yt-dlp/yt-dlp/releases)");
	if (!which("socat")) missing.push("socat (sudo apt install socat)");

	if (missing.length > 0) {
		ctx.ui.notify(`pi-amp: missing deps:\n  ${missing.join("\n  ")}`, "warning");
		return false;
	}
	return true;
}

// --- mpv IPC ---

function mpvCommand(cmd: Record<string, any>): string | null {
	try {
		const json = JSON.stringify(cmd);
		return execSync(`echo '${json}' | socat - ${IPC_SOCKET} 2>/dev/null`, {
			timeout: 2000,
			encoding: "utf-8",
		}).trim();
	} catch {
		return null;
	}
}

function getProperty(name: string): string | null {
	const resp = mpvCommand({ command: ["get_property", name] });
	if (!resp) return null;
	try {
		const parsed = JSON.parse(resp);
		return parsed.data != null ? String(parsed.data) : null;
	} catch {
		return null;
	}
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

// --- Status bar ---

function updateStatus() {
	if (!statusCtx) return;
	const theme = statusCtx.ui.theme;

	if (!isPlaying || !currentTrack.title) {
		statusCtx.ui.setStatus("pi-amp", theme.fg("dim", "♪ stopped"));
		return;
	}

	let posStr = "";
	const pos = getProperty("time-pos");
	const dur = getProperty("duration");
	if (pos && dur) {
		posStr = ` ${formatTime(parseFloat(pos))}/${formatTime(parseFloat(dur))}`;
	}

	const paused = getProperty("pause");
	const icon = paused === "true" ? "⏸" : "▶";
	const color = paused === "true" ? "warning" : "success";

	let display = currentTrack.title;
	if (display.length > 50) display = display.substring(0, 47) + "...";

	const queueStr = queue.length > 0 ? theme.fg("muted", ` [+${queue.length}]`) : "";
	const status = theme.fg(color, icon) + " " + theme.fg("text", display) + theme.fg("dim", posStr) + queueStr;
	statusCtx.ui.setStatus("pi-amp", status);
}

// --- Playback ---

function killMpv() {
	if (mpvProcess) {
		mpvProcess.kill("SIGTERM");
		mpvProcess = null;
	}
	try {
		if (existsSync(IPC_SOCKET)) unlinkSync(IPC_SOCKET);
	} catch {}
	isPlaying = false;
	currentTrack = { title: "", artist: "", duration: "", url: "" };
}

function findYtdlp(): string {
	// Prefer /usr/local/bin (pip install) over /usr/bin (apt — often outdated)
	if (existsSync("/usr/local/bin/yt-dlp")) return "/usr/local/bin/yt-dlp";
	return "yt-dlp";
}

async function playUrl(url: string): Promise<string> {
	killMpv();
	const ytdlp = findYtdlp();

	try {
		const info = execSync(
			`${ytdlp} --print title --print id "${url}" --no-playlist 2>/dev/null`,
			{ encoding: "utf-8", timeout: 15000 }
		).trim().split("\n");
		currentTrack.title = info[0] || "Unknown";
		currentTrack.url = url;
	} catch {
		currentTrack.title = url;
		currentTrack.url = url;
	}

	mpvProcess = spawn("mpv", [
		"--no-video",
		"--ytdl-format=bestaudio",
		`--input-ipc-server=${IPC_SOCKET}`,
		"--really-quiet",
		url,
	], {
		stdio: "ignore",
		detached: true,
	});

	mpvProcess.unref();
	isPlaying = true;

	mpvProcess.on("exit", () => {
		isPlaying = false;
		mpvProcess = null;
		if (queue.length > 0) {
			const next = queue.shift()!;
			playUrl(next.url);
		} else {
			updateStatus();
		}
	});

	// Wait for IPC socket
	for (let i = 0; i < 20; i++) {
		await new Promise(r => setTimeout(r, 250));
		if (existsSync(IPC_SOCKET)) break;
	}

	updateStatus();
	return currentTrack.title;
}

async function searchAndPlay(query: string): Promise<string> {
	const ytdlp = findYtdlp();
	try {
		const info = execSync(
			`${ytdlp} "ytsearch:${query.replace(/"/g, '\\"')}" --print title --print webpage_url --no-playlist 2>/dev/null`,
			{ encoding: "utf-8", timeout: 15000 }
		).trim().split("\n");

		const title = info[0] || query;
		const url = info[1] || "";

		if (!url) return `No results for: ${query}`;

		await playUrl(url);
		return title;
	} catch (e) {
		return `Search failed: ${e}`;
	}
}

// --- EQ ---

const EQ_DIR = join(homedir(), ".config/pipewire/filter-chain.conf.d");
const EQ_FILE = join(EQ_DIR, "pi-amp-eq.conf");

type EqBand = { freq: number; q: number; gain: number; label: string };

const EQ_PRESETS: Record<string, { name: string; bands: EqBand[] }> = {
	flat: {
		name: "Flat",
		bands: [
			{ freq: 60, q: 0.7, gain: 0, label: "bq_lowshelf" },
			{ freq: 150, q: 1.0, gain: 0, label: "bq_peaking" },
			{ freq: 500, q: 0.8, gain: 0, label: "bq_peaking" },
			{ freq: 2000, q: 1.0, gain: 0, label: "bq_peaking" },
			{ freq: 6000, q: 1.2, gain: 0, label: "bq_peaking" },
			{ freq: 12000, q: 0.7, gain: 0, label: "bq_highshelf" },
		],
	},
	bass: {
		name: "Bass Boost",
		bands: [
			{ freq: 60, q: 0.7, gain: 5, label: "bq_lowshelf" },
			{ freq: 150, q: 1.0, gain: 3, label: "bq_peaking" },
			{ freq: 500, q: 0.8, gain: 0, label: "bq_peaking" },
			{ freq: 2000, q: 1.0, gain: 0, label: "bq_peaking" },
			{ freq: 6000, q: 1.2, gain: 0, label: "bq_peaking" },
			{ freq: 12000, q: 0.7, gain: 0, label: "bq_highshelf" },
		],
	},
	live: {
		name: "Live Concert",
		bands: [
			{ freq: 60, q: 0.7, gain: 3, label: "bq_lowshelf" },
			{ freq: 150, q: 1.0, gain: 2, label: "bq_peaking" },
			{ freq: 500, q: 0.8, gain: -1.5, label: "bq_peaking" },
			{ freq: 2000, q: 1.0, gain: 3, label: "bq_peaking" },
			{ freq: 5000, q: 1.2, gain: -1, label: "bq_peaking" },
			{ freq: 9000, q: 0.7, gain: 1, label: "bq_highshelf" },
		],
	},
	vocal: {
		name: "Vocal / Acoustic",
		bands: [
			{ freq: 60, q: 0.7, gain: 1, label: "bq_lowshelf" },
			{ freq: 150, q: 1.0, gain: 0, label: "bq_peaking" },
			{ freq: 500, q: 0.8, gain: 1, label: "bq_peaking" },
			{ freq: 2000, q: 1.0, gain: 2.5, label: "bq_peaking" },
			{ freq: 6000, q: 1.2, gain: 2, label: "bq_peaking" },
			{ freq: 12000, q: 0.7, gain: 1.5, label: "bq_highshelf" },
		],
	},
};

function generateEqConf(preset: string, bands: EqBand[]): string {
	const nodes = bands.map((b, i) => `                    {
                        type  = builtin
                        name  = eq_band_${i + 1}
                        label = ${b.label}
                        control = { "Freq" = ${b.freq.toFixed(1)} "Q" = ${b.q.toFixed(1)} "Gain" = ${b.gain.toFixed(1)} }
                    }`).join("\n");

	const links = bands.slice(0, -1).map((_, i) =>
		`                    { output = "eq_band_${i + 1}:Out" input = "eq_band_${i + 2}:In" }`
	).join("\n");

	return `# pi-amp EQ — ${preset}
#
context.modules = [
    { name = libpipewire-module-filter-chain
        args = {
            node.description = "pi-amp EQ"
            media.name       = "pi-amp EQ"
            filter.graph = {
                nodes = [
${nodes}
                ]
                links = [
${links}
                ]
            }
            audio.channels = 2
            audio.position = [ FL FR ]
            capture.props = {
                node.name   = "effect_input.pi_amp_eq"
                media.class = Audio/Sink
            }
            playback.props = {
                node.name   = "effect_output.pi_amp_eq"
                node.passive = true
            }
        }
    }
]
`;
}

function applyEq(preset: string, bands: EqBand[]): boolean {
	try {
		mkdirSync(EQ_DIR, { recursive: true });
		writeFileSync(EQ_FILE, generateEqConf(preset, bands));
		execSync("systemctl --user restart pipewire pipewire-pulse 2>/dev/null", { timeout: 5000 });
		// Wait for reconnect
		execSync("sleep 2", { timeout: 5000 });
		// Try to reconnect Bluetooth if needed
		try {
			const devices = execSync("bluetoothctl devices Connected 2>/dev/null", { encoding: "utf-8" }).trim();
			const mac = devices.match(/([0-9A-F:]{17})/i);
			if (mac) {
				execSync(`bluetoothctl connect ${mac[1]} 2>/dev/null`, { timeout: 5000 });
				execSync("sleep 1", { timeout: 3000 });
			}
		} catch {}
		// Set EQ sink as default
		try {
			const sinkId = execSync("wpctl status 2>/dev/null", { encoding: "utf-8" })
				.match(/(\d+)\.\s+pi-amp EQ/)?.[1];
			if (sinkId) execSync(`wpctl set-default ${sinkId} 2>/dev/null`);
		} catch {}
		return true;
	} catch {
		return false;
	}
}

function removeEq(): boolean {
	try {
		if (existsSync(EQ_FILE)) unlinkSync(EQ_FILE);
		execSync("systemctl --user restart pipewire pipewire-pulse 2>/dev/null", { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

function parseCustomBands(args: string): EqBand[] | null {
	// Format: "60:+4 150:+2 500:-1 2000:+3 6000:0 12000:+1"
	const pairs = args.trim().split(/\s+/);
	if (pairs.length < 2) return null;

	return pairs.map((p, i) => {
		const [freq, gain] = p.split(":");
		if (!freq || !gain) return null;
		const f = parseFloat(freq);
		const g = parseFloat(gain);
		if (isNaN(f) || isNaN(g)) return null;
		return {
			freq: f,
			q: i === 0 ? 0.7 : i === pairs.length - 1 ? 0.7 : 1.0,
			gain: g,
			label: i === 0 ? "bq_lowshelf" : i === pairs.length - 1 ? "bq_highshelf" : "bq_peaking",
		};
	}).filter(Boolean) as EqBand[];
}

async function resolveQuery(query: string): Promise<{ title: string; url: string } | null> {
	const ytdlp = findYtdlp();
	const isUrl = query.startsWith("http");
	try {
		if (isUrl) {
			const info = execSync(
				`${ytdlp} --print title --print webpage_url "${query}" --no-playlist 2>/dev/null`,
				{ encoding: "utf-8", timeout: 15000 }
			).trim().split("\n");
			return { title: info[0] || query, url: info[1] || query };
		}
		const info = execSync(
			`${ytdlp} "ytsearch:${query.replace(/"/g, '\\"')}" --print title --print webpage_url --no-playlist 2>/dev/null`,
			{ encoding: "utf-8", timeout: 15000 }
		).trim().split("\n");
		if (!info[1]) return null;
		return { title: info[0] || query, url: info[1] };
	} catch {
		return null;
	}
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
	let statusInterval: ReturnType<typeof setInterval> | null = null;
	let depsOk = false;

	pi.on("session_start", async (_event, ctx) => {
		statusCtx = ctx;
		depsOk = checkDeps(ctx);

		if (depsOk) {
			updateStatus();
			if (statusInterval) clearInterval(statusInterval);
			statusInterval = setInterval(updateStatus, 2000);
		}
	});

	pi.on("session_shutdown", async () => {
		if (statusInterval) clearInterval(statusInterval);
		killMpv();
	});

	// /play command
	pi.registerCommand("play", {
		description: "Play music from YouTube — /play <search query or URL>",
		handler: async (args, ctx) => {
			if (!depsOk) { ctx.ui.notify("pi-amp: missing dependencies (check startup warning)", "error"); return; }

			if (!args?.trim()) {
				if (isPlaying) {
					mpvCommand({ command: ["cycle", "pause"] });
					updateStatus();
					return;
				}
				ctx.ui.notify("Usage: /play <search query or URL>", "info");
				return;
			}

			const query = args.trim();
			ctx.ui.notify(`🔍 ${query}...`, "info");

			const isUrl = query.startsWith("http");
			const title = isUrl ? await playUrl(query) : await searchAndPlay(query);
			ctx.ui.notify(`▶ ${title}`, "success");
		},
	});

	// /pause command
	pi.registerCommand("pause", {
		description: "Toggle pause",
		handler: async (_args, ctx) => {
			if (!isPlaying && !mpvProcess) {
				ctx.ui.notify("Nothing playing", "info");
				return;
			}
			mpvCommand({ command: ["cycle", "pause"] });
			const paused = getProperty("pause");
			ctx.ui.notify(paused === "true" ? "⏸ Paused" : "▶ Playing", "info");
			updateStatus();
		},
	});

	// /stop command
	pi.registerCommand("stop", {
		description: "Stop playback and clear queue",
		handler: async (_args, ctx) => {
			queue.length = 0;
			killMpv();
			updateStatus();
			ctx.ui.notify("⏹ Stopped (queue cleared)", "info");
		},
	});

	// /np command
	pi.registerCommand("np", {
		description: "Show what's currently playing",
		handler: async (_args, ctx) => {
			if (!isPlaying || !currentTrack.title) {
				ctx.ui.notify("Nothing playing", "info");
				return;
			}
			const pos = getProperty("time-pos");
			const dur = getProperty("duration");
			let info = `▶ ${currentTrack.title}`;
			if (pos && dur) {
				info += ` [${formatTime(parseFloat(pos))}/${formatTime(parseFloat(dur))}]`;
			}
			ctx.ui.notify(info, "info");
		},
	});

	// /vol command
	pi.registerCommand("vol", {
		description: "Set volume — /vol <0-100>",
		handler: async (args, ctx) => {
			const vol = parseInt(args?.trim() || "");
			if (isNaN(vol) || vol < 0 || vol > 100) {
				const current = getProperty("volume");
				ctx.ui.notify(`🔊 Volume: ${current || "?"}%`, "info");
				return;
			}
			mpvCommand({ command: ["set_property", "volume", vol] });
			ctx.ui.notify(`🔊 Volume: ${vol}%`, "info");
		},
	});

	// /queue command
	pi.registerCommand("queue", {
		description: "Add a song to the queue — /queue <search query or URL>",
		handler: async (args, ctx) => {
			if (!depsOk) { ctx.ui.notify("pi-amp: missing dependencies", "error"); return; }

			if (!args?.trim()) {
				if (queue.length === 0) {
					ctx.ui.notify("Queue is empty", "info");
				} else {
					const list = queue.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
					ctx.ui.notify(`Queue (${queue.length}):\n${list}`, "info");
				}
				return;
			}

			const query = args.trim();
			ctx.ui.notify(`🔍 Queuing: ${query}...`, "info");
			const result = await resolveQuery(query);
			if (!result) {
				ctx.ui.notify(`No results for: ${query}`, "warning");
				return;
			}
			queue.push(result);
			ctx.ui.notify(`➕ Queued: ${result.title} (#${queue.length})`, "success");

			// Auto-play if nothing is playing
			if (!isPlaying && !mpvProcess) {
				const next = queue.shift()!;
				await playUrl(next.url);
				ctx.ui.notify(`▶ ${next.title}`, "success");
			}
		},
	});

	// /skip command
	pi.registerCommand("skip", {
		description: "Skip to next song in queue",
		handler: async (_args, ctx) => {
			if (queue.length === 0 && !isPlaying) {
				ctx.ui.notify("Nothing to skip", "info");
				return;
			}
			if (queue.length === 0) {
				queue.length = 0; // prevent exit handler auto-play
				killMpv();
				updateStatus();
				ctx.ui.notify("Queue empty — stopped", "info");
				return;
			}
			// Kill current — the exit handler will auto-play next from queue
			killMpv();
			const track = queue.shift()!;
			await playUrl(track.url);
			ctx.ui.notify(`⏭ ${track.title} (${queue.length} left)`, "success");
		},
	});

	// /eq command
	pi.registerCommand("eq", {
		description: "EQ presets — /eq flat|bass|live|vocal|off or /eq 60:+4 150:+2 ...",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase() || "";

			if (!arg) {
				const presets = Object.entries(EQ_PRESETS).map(([k, v]) => `${k} — ${v.name}`).join("\n  ");
				ctx.ui.notify(`EQ presets:\n  ${presets}\n  off — disable EQ\n  custom — /eq 60:+4 150:+2 500:-1 ...`, "info");
				return;
			}

			if (arg === "off") {
				removeEq();
				ctx.ui.notify("🔊 EQ disabled", "info");
				return;
			}

			if (EQ_PRESETS[arg]) {
				const preset = EQ_PRESETS[arg];
				ctx.ui.notify(`Applying EQ: ${preset.name}...`, "info");
				const ok = applyEq(preset.name, preset.bands);
				if (ok) {
					const summary = preset.bands.map(b => `${b.freq}Hz: ${b.gain > 0 ? "+" : ""}${b.gain}dB`).join(", ");
					ctx.ui.notify(`🔊 EQ: ${preset.name} (${summary})`, "success");
				} else {
					ctx.ui.notify("EQ failed — is PipeWire running?", "error");
				}
				return;
			}

			// Try custom bands
			const bands = parseCustomBands(arg);
			if (bands && bands.length >= 2) {
				ctx.ui.notify("Applying custom EQ...", "info");
				const ok = applyEq("Custom", bands);
				if (ok) {
					const summary = bands.map(b => `${b.freq}Hz: ${b.gain > 0 ? "+" : ""}${b.gain}dB`).join(", ");
					ctx.ui.notify(`🔊 EQ: Custom (${summary})`, "success");
				} else {
					ctx.ui.notify("EQ failed — is PipeWire running?", "error");
				}
				return;
			}

			ctx.ui.notify(`Unknown preset: ${arg}. Use /eq for options.`, "warning");
		},
	});

	// LLM tool — EQ
	pi.registerTool({
		name: "set_eq",
		label: "Set EQ",
		description: "Set audio EQ preset or custom bands. Presets: flat, bass, live, vocal, off. Custom: provide freq:gain pairs like '60:+4 150:+2 500:-1'.",
		parameters: Type.Object({
			preset: Type.String({ description: "Preset name (flat, bass, live, vocal, off) or custom bands like '60:+4 150:+2 500:-1 2000:+3 6000:0 12000:+1'" }),
		}),
		async execute(_toolCallId, params) {
			const arg = params.preset.trim().toLowerCase();

			if (arg === "off") {
				removeEq();
				return { content: [{ type: "text", text: "EQ disabled" }], details: { preset: "off" } };
			}

			if (EQ_PRESETS[arg]) {
				const preset = EQ_PRESETS[arg];
				const ok = applyEq(preset.name, preset.bands);
				if (!ok) return { content: [{ type: "text", text: "EQ failed — is PipeWire running?" }], isError: true };
				const summary = preset.bands.map(b => `${b.freq}Hz: ${b.gain > 0 ? "+" : ""}${b.gain}dB`).join(", ");
				return { content: [{ type: "text", text: `EQ set to ${preset.name}: ${summary}` }], details: { preset: arg, bands: preset.bands } };
			}

			const bands = parseCustomBands(arg);
			if (bands && bands.length >= 2) {
				const ok = applyEq("Custom", bands);
				if (!ok) return { content: [{ type: "text", text: "EQ failed — is PipeWire running?" }], isError: true };
				const summary = bands.map(b => `${b.freq}Hz: ${b.gain > 0 ? "+" : ""}${b.gain}dB`).join(", ");
				return { content: [{ type: "text", text: `Custom EQ applied: ${summary}` }], details: { preset: "custom", bands } };
			}

			return { content: [{ type: "text", text: `Unknown preset: ${arg}. Available: flat, bass, live, vocal, off, or custom bands.` }], isError: true };
		},
	});

	// LLM tool — queue music
	pi.registerTool({
		name: "queue_music",
		label: "Queue Music",
		description: "Add a song to the queue. It will play after the current song finishes. If nothing is playing, it starts immediately.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query or YouTube URL" }),
		}),
		async execute(_toolCallId, params) {
			if (!depsOk) {
				return { content: [{ type: "text", text: "pi-amp: missing dependencies" }], isError: true };
			}

			const result = await resolveQuery(params.query);
			if (!result) {
				return { content: [{ type: "text", text: `No results for: ${params.query}` }], isError: true };
			}

			if (!isPlaying && !mpvProcess) {
				await playUrl(result.url);
				return {
					content: [{ type: "text", text: `Now playing: ${result.title} (queue empty, started immediately)` }],
					details: { title: result.title, position: 0 },
				};
			}

			queue.push(result);
			return {
				content: [{ type: "text", text: `Queued #${queue.length}: ${result.title}` }],
				details: { title: result.title, position: queue.length },
			};
		},
	});

	// LLM tool — play music
	pi.registerTool({
		name: "play_music",
		label: "Play Music",
		description: "Search YouTube and play music. Use for any music playback request.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query or YouTube URL" }),
		}),
		async execute(_toolCallId, params) {
			if (!depsOk) {
				return {
					content: [{ type: "text", text: "pi-amp: missing dependencies (mpv, yt-dlp, or socat). Ask the user to install them." }],
					isError: true,
				};
			}

			const query = params.query;
			const isUrl = query.startsWith("http");
			const title = isUrl ? await playUrl(query) : await searchAndPlay(query);

			return {
				content: [{ type: "text", text: `Now playing: ${title}` }],
				details: { title, query },
			};
		},
	});
}
