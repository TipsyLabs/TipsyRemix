# TipsyRemix

2-Deck-DJ-App im Browser: zwei Songs laden und live mixen – gebaut für iPad/Touch, läuft aber auch am PC.

**Live:** https://tipsylabs.github.io/TipsyRemix/

## Funktionen
- 2 Decks mit Wellenform, Beatgrid, automatischer BPM-Erkennung, CUE, 4 Hot Cues, Loops (1–16 Beats)
- Tempo ±8/16/50 %, SYNC (Tempo + Beat), Key Lock (Tonhöhe bleibt gleich)
- Mixer: Gain, 3-Band-Isolator (Bass/Mitten/Höhen bis Kill), Filter (an den Anschlägen stumm), Kanalfader, Crossfader
- Echo Out (1 Takt, Ausklingzeit 1–5 s)
- Kanal-Mute: Finger auf die Fader-Schiene unter den Griff legen (stumm, solange er liegt)
- Wellenform-Modus SMUDGE (Scrub/Pitch-Bend) oder VINYL (Platte anfassen = Stopp, ziehen = Scratch vor/zurück)
- Playlist (Lasche unten rechts): mehrere Songs hinzufügen, Tippen lädt ins freie Deck, Halten & Ziehen sortiert
- Automix: spielt die Playlist der Reihe nach mit Crossfader-Überblendung (3–10 s) und Bass-Übergabe, danach wieder von vorn
- Endwarnung: in den letzten 30 s eines Songs pulsiert die Wellenform rot auf der "1" jedes Takts
- Aufnahme des Mixes als MP3 (320 kbps)
- Alles auf einem Bildschirm: die Konsole skaliert sich automatisch auf iPad quer/hoch

## Benutzung
- Online: Link oben öffnen, auf „Laden“ tippen und Songs von deinem Gerät wählen. Die Musik bleibt auf deinem Gerät, nichts wird hochgeladen.
- Lokal: `index.html` per Doppelklick öffnen.

## Entwicklung
- `index.html`, `style.css`, `app.js` – die App (ohne Build-Schritt lauffähig)
- `lib/lame.min.js` – MP3-Encoder [lamejs](https://github.com/zhuker/lamejs) (LGPL)
- `node build.js` – erzeugt `dist/` als Einzelseite für claude.ai
