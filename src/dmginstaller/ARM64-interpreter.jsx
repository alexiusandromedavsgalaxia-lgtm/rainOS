import { MachoLoader, Arm64Interpreter } from "./macho-loader.jsx";
import { VCPU } from "../vcpu/vcpu.jsx";

// Cuando el usuario arrastra una app desde el DMG a Applications:
async function installApp(machoBytes) {
  // 1. Crear una VCPU fresca para el proceso
  const vcpu = new VCPU({ id: 0 });
  vcpu.init();
  
  // 2. Crear el loader con resolución de símbolos
  const loader = new MachoLoader({
    vcpu,
    resolver: (symbol, file, ordinal) => {
      // Resolver contra las dylibs ya cargadas en el sistema
      // (LibSystem, libc++, libobjc, etc.)
      return resolverSystemSymbol(symbol);
    },
  });
  
  // 3. Cargar el Mach-O
  const file = await loader.load(machoBytes, {
    path: "/Applications/MyApp.app/Contents/MacOS/MyApp",
    slide: 0x100000000n,
  });
  
  console.log("Cargado:", file.header.toString());
  console.log("Arch:", file.arch);
  console.log("Entry:", loader.entryPoint.toString(16));
  console.log("Segmentos:", file.segments.map(s => s.segname));
  console.log("Dylibs:", file.dylibs.map(d => d.name));
  console.log("Símbolos:", file.symbols.length);
  
  // 4. Ejecutar
  const interpreter = new Arm64Interpreter(vcpu);
  interpreter.registerSyscall(0x80, (cpu) => {
    // syscall personalizada
  });
  
  try {
    interpreter.run(100_000);
  } catch (err) {
    console.log("Ejecución detenida:", err.message);
  }
  
  return file;
}
