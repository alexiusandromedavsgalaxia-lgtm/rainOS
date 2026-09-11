# Minimal example

The smallest possible rainOS setup: only the kernel, plus a simple window
chrome built with `useDraggable` and `useResizable`.

## Run

From the repo root:

```bash
npm run dev```

Then open http://localhost:5173.

What you can do

Open a window with the "Abrir ventana" button.
Drag it by the titlebar.
Resize it from the bottom-right corner, right edge or bottom edge.
Minimize, maximize or close it using the traffic lights.
Open a cascade of 5 windows.
Minimize all windows at once.
Close all windows at once.
What this example does not show

No boot chain.
No bootloader.
No setup assistant.
No lock screen.
No dock or menu bar interactions beyond the visual chrome.
For the full experience, see examples/full-boot/.
