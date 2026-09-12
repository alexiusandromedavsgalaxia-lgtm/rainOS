import { AppLauncher } from "rainOS/macho/app-launcher";

const launcher = new AppLauncher({
  onOutput: (text, { pid }) => {
    console.log(`[pid ${pid}]`, text);
  },
});

// Lanzar desde bytes de un .app (ZIP) o un binario Mach-O
const pid = await launcher.launch({
  bundleBytes: bytesDeLaApp,           // Uint8Array
  bundlePath: "/Applications/MiApp.app",
  argv: ["MiApp"],
  env: { HOME: "/Users/usuario" },
  libraryResolver: async (path, name) => {
    // Devolver bytes de una dylib. Puede venir de:
    // - Un archivo en el bundle
    // - El dyld cache del sistema (que ya emulamos)
    // - Un fetch a un servidor
    return null;                        // null = usar la implementación de sistema
  },
});
