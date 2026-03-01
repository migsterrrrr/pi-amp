# pi-amp 🎵

<p align="center">
  <img src="pi-amp.png" width="400" alt="pi-amp — AI DJ robot with headphones and a tube amp" />
</p>

Retro CLI music player extension for [pi](https://github.com/badlogic/pi-mono). YouTube search + streaming, EQ, queue, and an LLM that can DJ for you.

## Install

```bash
pi install git:github.com/migsterrrrr/pi-amp
```

### System dependencies

You need these installed on your system:

```bash
sudo apt install mpv socat
pip install yt-dlp   # don't use apt — it's outdated
```

| Tool | What it does | Link |
|------|-------------|------|
| [mpv](https://mpv.io/) | Audio playback | `sudo apt install mpv` |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | YouTube search + stream extraction | `pip install yt-dlp` |
| [socat](http://www.dest-unreach.org/socat/) | mpv IPC control | `sudo apt install socat` |
| [PipeWire](https://pipewire.org/) | For EQ (optional, default on modern Linux) | Already installed on Ubuntu 22.04+, Fedora, Arch |

The extension checks for missing deps at startup and tells you what to install.

## Usage

### Slash commands

| Command | What it does |
|---------|-------------|
| `/play <query>` | Search YouTube and stream |
| `/play` (no args) | Toggle pause |
| `/pause` | Toggle pause |
| `/stop` | Stop playback and clear queue |
| `/np` | Show now-playing |
| `/vol <0-100>` | Set volume |
| `/queue <query>` | Add song to queue |
| `/queue` (no args) | Show the queue |
| `/skip` | Skip to next song |
| `/eq <preset>` | EQ preset: flat, bass, live, vocal, off |
| `/eq 60:+4 150:+2 ...` | Custom EQ bands |

### AI DJ

The extension registers LLM tools — the AI can play music, queue songs, and adjust EQ on its own:

- *"play something chill"* → `play_music`
- *"queue up 5 similar songs"* → `queue_music`
- *"make it sound warmer"* → `set_eq`

### Status bar

Now-playing appears in pi's status bar: `▶ Song Name 1:23/4:17 [+3]`

The `[+3]` shows how many songs are queued. When a song finishes, the next one starts automatically.

## How it works

```
yt-dlp "ytsearch:<query>"  →  finds YouTube URL
mpv --no-video <url>       →  streams audio
socat → IPC socket         →  play/pause/vol/position
PipeWire filter-chain      →  EQ (optional)
System audio output        →  speakers, Bluetooth, etc.
```

## Platform

Linux only for now. Audio playback works on any Linux with PulseAudio or PipeWire (i.e. basically all of them). The `/eq` command requires PipeWire specifically — it writes a filter-chain config. PipeWire is the default audio stack on Ubuntu 22.04+, Fedora 34+, and Arch. If you're on an older distro with PulseAudio only, everything works except EQ.

### Want to help?

macOS and Windows support would be great — PRs welcome. The main thing to figure out:
- **macOS**: CoreAudio EQ instead of PipeWire filter-chain. Playback (mpv/yt-dlp) should work as-is.
- **Windows**: Audio routing. mpv/yt-dlp work on Windows but EQ would need a different approach.

Other ideas: Spotify integration, playlist persistence, retro Winamp ASCII widget, better queue management. Open an issue or just send a PR.

## License

MIT
