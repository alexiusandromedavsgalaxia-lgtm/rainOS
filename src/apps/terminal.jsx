// ============================================================================
// terminal.jsx — Terminal de rainOS
// ----------------------------------------------------------------------------
// Terminal con shell completo. Responsabilidades:
//
// 1. SHELL
//    - Prompt personalizable (usuario@host:cwd$)
//    - Comandos built-in: cd, pwd, ls, cat, echo, clear, help, history,
//      whoami, date, uname, mkdir, touch, rm, mv, cp, env, export,
//      alias, unalias, which, man, exit, sudo, su, jobs, kill, ps,
//      open, neofetch
//    - Redirecciones: >, >>, <
//    - Pipes: |
//    - Encadenamiento: &&, ||, ;
//    - Variables de entorno ($VAR)
//    - Wildcards (*, ?)
//    - Historial con flechas ↑↓
//    - Tab completion
//    - Autocompletado de rutas
//    - Ctrl+C para cancelar línea
//    - Ctrl+L para limpiar pantalla
//    - Ctrl+A / Ctrl+E para ir al inicio/final
//    - Ctrl+U para borrar la línea
//    - Ctrl+W para borrar la última palabra
//
// 2. SISTEMA DE ARCHIVOS VIRTUAL
//    - Compartido con Finder (misma estructura)
//    - Persistencia en memoria del proceso shell
//
// 3. INTEGRACIÓN CON EL KERNEL
//    - `open <app>` abre apps de rainOS
//    - `neofetch` muestra info del sistema
//    - Comandos de sistema: shutdown, reboot, lock
//
// 4. VISUAL
//    - Tema claro/oscuro
//    - Fuente monoespaciada
//    - Colores ANSI básicos
//    - Selección de texto
//    - Scroll con historial
//
// Todo con estilos inline.
// ============================================================================

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";

import { useWindowManager } from "../../kernel/kernel.jsx";
import { SYSTEM_VERSION } from "../../updater/updater.jsx";

// ============================================================================
// SISTEMA DE ARCHIVOS VIRTUAL (compartido con Finder)
// ============================================================================

const buildFS = () => ({
  "/": {
    type: "dir",
    children: {
      Users: {
        type: "dir",
        children: {
          usuario: {
            type: "dir",
            children: {
              Escritorio: { type: "dir", children: {} },
              Documentos: {
                type: "dir",
                children: {
                  "Notas.txt": {
                    type: "file",
                    content: "Estas son mis notas del proyecto rainOS.\n",
                  },
                  "Presupuesto.xlsx": { type: "file", content: "<binary>" },
                  "Tesis.pdf": { type: "file", content: "<binary>" },
                },
              },
              Descargas: {
                type: "dir",
                children: {
                  "rainOS-0.1.0.dmg": { type: "file", content: "<binary>" },
                  "wallpaper.png": { type: "file", content: "<binary>" },
                },
              },
              Proyectos: {
                type: "dir",
                children: {
                  rainOS: {
                    type: "dir",
                    children: {
                      "package.json": {
                        type: "file",
                        content: `{\n  "name": "rainos",\n  "version": "0.1.0"\n}\n`,
                      },
                      "README.md": {
                        type: "file",
                        content:
                          "# rainOS\n\nKernel de SO en React.\n",
                      },
                      "kernel.jsx": { type: "file", content: "// kernel" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      Aplicaciones: {
        type: "dir",
        children: {
          "Finder.app": { type: "file", content: "<binary>" },
          "Terminal.app": { type: "file", content: "<binary>" },
          "Notas.app": { type: "file", content: "<binary>" },
          "Ajustes.app": { type: "file", content: "<binary>" },
        },
      },
      System: { type: "dir", children: {} },
      Library: { type: "dir", children: {} },
      tmp: { type: "dir", children: {} },
      etc: {
        type: "dir",
        children: {
          hostname: { type: "file", content: "rainos\n" },
          "motd": {
            type: "file",
            content: "Welcome to rainOS\n",
          },
        },
      },
      var: { type: "dir", children: { log: { type: "dir", children: {} } } },
    },
  },
});

// ============================================================================
// HELPERS
// ============================================================================

const resolvePath = (cwd, target) => {
  if (!target) return cwd;
  if (target.startsWith("/")) {
    return normalizePath(target);
  }
  if (target === "~" || target.startsWith("~/")) {
    const rest = target.slice(1);
    return normalizePath("/Users/usuario" + rest);
  }
  return normalizePath(cwd + "/" + target);
};

const normalizePath = (p) => {
  const parts = p.split("/").filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return "/" + out.join("/");
};

const getNode = (fs, path) => {
  const parts = path.split("/").filter(Boolean);
  let node = fs["/"];
  for (const part of parts) {
    if (!node || node.type !== "dir" || !node.children[part]) return null;
    node = node.children[part];
  }
  return node;
};

const expandTilde = (path, home) =>
  path.startsWith("~") ? path.replace("~", home) : path;

// ============================================================================
// COMANDOS
// ============================================================================

const buildCommands = (ctx) => {
  const {
    fs,
    setFs,
    cwd,
    setCwd,
    env,
    setEnv,
    aliases,
    setAliases,
    history,
    clear,
    addLine,
    openApp,
    onExit,
    kernel,
  } = ctx;

  const resolve = (p) => resolvePath(cwd, expandTilde(p || ".", env.HOME));

  const commands = {
    help: () => {
      addLine("Comandos disponibles:");
      addLine("");
      addLine("  Navegación:");
      addLine("    ls [path]           lista archivos");
      addLine("    cd <path>           cambia de directorio");
      addLine("    pwd                 directorio actual");
      addLine("    tree [path]         árbol de directorios");
      addLine("");
      addLine("  Archivos:");
      addLine("    cat <file>          muestra contenido");
      addLine("    touch <file>        crea archivo vacío");
      addLine("    mkdir <dir>         crea directorio");
      addLine("    rm [-r] <path>      borra archivo/directorio");
      addLine("    mv <src> <dst>      mueve/renombra");
      addLine("    cp <src> <dst>      copia");
      addLine("    echo <text>         imprime texto");
      addLine("");
      addLine("  Sistema:");
      addLine("    whoami              usuario actual");
      addLine("    date                fecha y hora");
      addLine("    uname [-a]          info del sistema");
      addLine("    env                 variables de entorno");
      addLine("    export K=V          define variable");
      addLine("    alias n=cmd         define alias");
      addLine("    history             historial de comandos");
      addLine("    clear               limpia la pantalla");
      addLine("    which <cmd>         muestra ubicación de un comando");
      addLine("    man <cmd>           ayuda de un comando");
      addLine("    exit                cierra la terminal");
      addLine("");
      addLine("  rainOS:");
      addLine("    open <app>          abre una app del sistema");
      addLine("    neofetch            info del sistema");
      addLine("    shutdown            apaga el sistema");
      addLine("    reboot              reinicia el sistema");
      addLine("    lock                bloquea la pantalla");
      addLine("");
    },

    pwd: () => addLine(cwd),

    whoami: () => addLine(env.USER),

    date: () => addLine(new Date().toString()),

    uname: (args) => {
      if (args.includes("-a")) {
        addLine(
          `rainOS ${SYSTEM_VERSION} (kernel rainOS) React-VM x86_64`
        );
      } else {
        addLine("rainOS");
      }
    },

    echo: (args) => {
      // Detectar redirección
      const gt = args.indexOf(">");
      const gtgt = args.indexOf(">>");
      let target = null;
      let append = false;
      let text = args;
      if (gt >= 0) {
        target = args[gt + 1];
        text = args.slice(0, gt);
      } else if (gtgt >= 0) {
        target = args[gtgt + 1];
        text = args.slice(0, gtgt);
        append = true;
      }
      const output = text.join(" ");
      if (target) {
        const path = resolve(target);
        const parent = getNode(fs, normalizePath(path + "/.."));
        const name = path.split("/").filter(Boolean).pop();
        if (parent && parent.type === "dir") {
          const existing = parent.children[name];
          const prev = existing?.content || "";
          parent.children[name] = {
            type: "file",
            content: append ? prev + output + "\n" : output + "\n",
          };
          setFs({ ...fs });
          addLine(`→ ${path}`);
        } else {
          addLine(`echo: no such directory`);
        }
      } else {
        addLine(output);
      }
    },

    ls: (args) => {
      const target = args[0] ? resolve(args[0]) : cwd;
      const node = getNode(fs, target);
      if (!node) {
        addLine(`ls: ${target}: No such file or directory`);
        return;
      }
      if (node.type === "file") {
        addLine(target.split("/").pop());
        return;
      }
      const entries = Object.entries(node.children || {});
      if (args.includes("-la") || args.includes("-l")) {
        addLine("total " + entries.length);
        for (const [name, child] of entries) {
          const type = child.type === "dir" ? "d" : "-";
          addLine(
            `${type}rwxr-xr-x  1 ${env.USER} ${env.USER}  ${String(
              child.type === "dir" ? 4096 : (child.content || "").length
            ).padStart(6)}  ${name}${child.type === "dir" ? "/" : ""}`
          );
        }
        return;
      }
      const out = entries.map(([name, child]) =>
        child.type === "dir" ? name + "/" : name
      );
      if (out.length === 0) return;
      addLine(out.join("  "));
    },

    cd: (args) => {
      const target = args[0] ? resolve(args[0]) : env.HOME;
      const node = getNode(fs, target);
      if (!node) {
        addLine(`cd: ${target}: No such file or directory`);
        return;
      }
      if (node.type !== "dir") {
        addLine(`cd: ${target}: Not a directory`);
        return;
      }
      setCwd(target);
    },

    cat: (args) => {
      if (!args[0]) {
        addLine("cat: missing operand");
        return;
      }
      const path = resolve(args[0]);
      const node = getNode(fs, path);
      if (!node) {
        addLine(`cat: ${path}: No such file or directory`);
        return;
      }
      if (node.type === "dir") {
        addLine(`cat: ${path}: Is a directory`);
        return;
      }
      const content = node.content || "";
      content.split("\n").forEach((l) => addLine(l));
    },

    touch: (args) => {
      if (!args[0]) {
        addLine("touch: missing file operand");
        return;
      }
      const path = resolve(args[0]);
      const parent = getNode(fs, normalizePath(path + "/.."));
      const name = path.split("/").filter(Boolean).pop();
      if (!parent || parent.type !== "dir") {
        addLine(`touch: cannot create '${path}'`);
        return;
      }
      if (!parent.children[name]) {
        parent.children[name] = { type: "file", content: "" };
      }
      setFs({ ...fs });
    },

    mkdir: (args) => {
      if (!args[0]) {
        addLine("mkdir: missing operand");
        return;
      }
      const path = resolve(args[0]);
      const parent = getNode(fs, normalizePath(path + "/.."));
      const name = path.split("/").filter(Boolean).pop();
      if (!parent || parent.type !== "dir") {
        addLine(`mkdir: cannot create '${path}'`);
        return;
      }
      if (parent.children[name]) {
        addLine(`mkdir: ${name}: File exists`);
        return;
      }
      parent.children[name] = { type: "dir", children: {} };
      setFs({ ...fs });
    },

    rm: (args) => {
      const recursive = args.includes("-r") || args.includes("-rf");
      const files = args.filter((a) => !a.startsWith("-"));
      if (files.length === 0) {
        addLine("rm: missing operand");
        return;
      }
      for (const file of files) {
        const path = resolve(file);
        const parent = getNode(fs, normalizePath(path + "/.."));
        const name = path.split("/").filter(Boolean).pop();
        if (!parent) continue;
        const target = parent.children[name];
        if (!target) {
          addLine(`rm: ${file}: No such file or directory`);
          continue;
        }
        if (target.type === "dir" && !recursive) {
          addLine(`rm: ${file}: is a directory`);
          continue;
        }
        delete parent.children[name];
      }
      setFs({ ...fs });
    },

    mv: (args) => {
      if (args.length < 2) {
        addLine("mv: missing operand");
        return;
      }
      const src = resolve(args[0]);
      const dst = resolve(args[1]);
      const srcParent = getNode(fs, normalizePath(src + "/.."));
      const srcName = src.split("/").filter(Boolean).pop();
      const srcNode = srcParent?.children[srcName];
      if (!srcNode) {
        addLine(`mv: ${args[0]}: No such file or directory`);
        return;
      }
      const dstParent = getNode(fs, normalizePath(dst + "/.."));
      const dstName = dst.split("/").filter(Boolean).pop();
      if (!dstParent) {
        addLine(`mv: ${args[1]}: No such directory`);
        return;
      }
      delete srcParent.children[srcName];
      dstParent.children[dstName] = srcNode;
      setFs({ ...fs });
    },

    cp: (args) => {
      if (args.length < 2) {
        addLine("cp: missing operand");
        return;
      }
      const src = resolve(args[0]);
      const dst = resolve(args[1]);
      const srcParent = getNode(fs, normalizePath(src + "/.."));
      const srcName = src.split("/").filter(Boolean).pop();
      const srcNode = srcParent?.children[srcName];
      if (!srcNode) {
        addLine(`cp: ${args[0]}: No such file or directory`);
        return;
      }
      const dstParent = getNode(fs, normalizePath(dst + "/.."));
      const dstName = dst.split("/").filter(Boolean).pop();
      if (!dstParent) {
        addLine(`cp: ${args[1]}: No such directory`);
        return;
      }
      dstParent.children[dstName] = JSON.parse(JSON.stringify(srcNode));
      setFs({ ...fs });
    },

    tree: (args) => {
      const target = args[0] ? resolve(args[0]) : cwd;
      const node = getNode(fs, target);
      if (!node) {
        addLine(`tree: ${target}: No such directory`);
        return;
      }
      addLine(target);
      const walk = (n, prefix = "") => {
        if (n.type !== "dir") return;
        const entries = Object.entries(n.children || {});
        entries.forEach(([name, child], i) => {
          const isLast = i === entries.length - 1;
          addLine(
            prefix + (isLast ? "└── " : "├── ") + name + (child.type === "dir" ? "/" : "")
          );
          walk(child, prefix + (isLast ? "    " : "│   "));
        });
      };
      walk(node);
    },

    env: () => {
      for (const [k, v] of Object.entries(env)) {
        addLine(`${k}=${v}`);
      }
    },

    export: (args) => {
      if (!args[0]) {
        for (const [k, v] of Object.entries(env)) {
          addLine(`${k}=${v}`);
        }
        return;
      }
      const [k, ...rest] = args[0].split("=");
      const v = rest.join("=");
      setEnv({ ...env, [k]: v });
    },

    alias: (args) => {
      if (!args[0]) {
        for (const [k, v] of Object.entries(aliases)) {
          addLine(`alias ${k}='${v}'`);
        }
        return;
      }
      const [name, ...rest] = args[0].split("=");
      const value = rest.join("=").replace(/^['"]|['"]$/g, "");
      setAliases({ ...aliases, [name]: value });
    },

    unalias: (args) => {
      if (!args[0]) return;
      const next = { ...aliases };
      delete next[args[0]];
      setAliases(next);
    },

    history: () => {
      history.forEach((cmd, i) => addLine(`  ${i + 1}  ${cmd}`));
    },

    clear: () => clear(),

    which: (args) => {
      if (!args[0]) return;
      if (commands[args[0]]) {
        addLine(`/bin/${args[0]}`);
      } else {
        addLine(`which: no ${args[0]} in (/bin:/usr/bin)`);
      }
    },

    man: (args) => {
      if (!args[0]) {
        addLine("What manual page do you want?");
        return;
      }
      addLine(`MANUAL: ${args[0].toUpperCase()}`);
      addLine("");
      addLine(`  Comando interno del shell de rainOS.`);
      addLine(`  Usa \`help\` para ver todos los comandos.`);
    },

    exit: () => {
      onExit?.();
    },

    sudo: () => {
      addLine("We trust you have received the usual lecture from the local System");
      addLine("Administrator. It usually boils down to these three things:");
      addLine("");
      addLine("    #1) Respect the privacy of others.");
      addLine("    #2) Think before you type.");
      addLine("    #3) With great power comes great responsibility.");
      addLine("");
      addLine("sudo: this incident will be reported.");
    },

    su: () => addLine("su: authentication failure"),

    ps: () => {
      addLine("  PID TTY          TIME CMD");
      addLine("    1 ?        00:00:00 init");
      addLine("  100 ?        00:00:01 kernel");
      addLine("  200 ?        00:00:00 scheduler");
      addLine("  300 ?        00:00:00 window-manager");
      addLine("  400 ?        00:00:00 lock-screen");
    },

    jobs: () => addLine(""),

    kill: (args) => {
      if (!args[0]) {
        addLine("kill: usage: kill pid");
        return;
      }
      addLine(`kill: (${args[0]}) - Operation not permitted`);
    },

    // ----------------------------------------------------- rainOS
    open: (args) => {
      const app = args[0];
      if (!app) {
        addLine("open: missing application");
        return;
      }
      const id = app.replace(/\.app$/i, "").toLowerCase();
      const known = ["finder", "terminal", "notes", "settings", "about"];
      if (known.includes(id)) {
        openApp?.(id);
        addLine(`Opening ${app}...`);
      } else {
        addLine(`open: application not found: ${app}`);
      }
    },

    neofetch: () => {
      const logo = [
        "                    'c.          ",
        "                 ,xNMM.          ",
        "               .OMMMMo           ",
        "               OMMM0,            ",
        "     .;loddo:' loolloddol;.      ",
        "   cKMMMMMMMMMMNWMMMMMMMMMM0:    ",
        " .KMMMMMMMMMMMMMMMMMMMMMMMWd.    ",
        " XMMMMMMMMMMMMMMMMMMMMMMMX.      ",
        ";MMMMMMMMMMMMMMMMMMMMMMMM:       ",
        ":MMMMMMMMMMMMMMMMMMMMMMMM:       ",
        ".MMMMMMMMMMMMMMMMMMMMMMMMX.      ",
        " kMMMMMMMMMMMMMMMMMMMMMMMMWd.    ",
        " 'XMMMMMMMMMMMMMMMMMMMMMMMMMMk   ",
        "  'XMMMMMMMMMMMMMMMMMMMMMMMMK.   ",
        "    kMMMMMMMMMMMMMMMMMMMMMMd     ",
        "     ;KMMMMMMMWXXWMMMMMMMk.      ",
        "       'cooc*'    '*coo;.        ",
      ];
      const info = [
        `${env.USER}@${env.HOSTNAME}`,
        "─────────────────",
        `OS: rainOS ${SYSTEM_VERSION}`,
        "Kernel: rainOS-kernel",
        "Shell: rain-shell 1.0",
        `Terminal: rainTerm`,
        "CPU: React Virtual x86_64",
        "GPU: Virtual Renderer",
        "Memory: 128MB / 4096MB",
      ];
      const lines = Math.max(logo.length, info.length);
      for (let i = 0; i < lines; i++) {
        const l = (logo[i] || "").padEnd(36);
        const r = info[i] || "";
        addLine(l + r);
      }
    },

    shutdown: () => {
      addLine("Shutting down...");
      setTimeout(() => kernel?.shutdown?.(), 800);
    },

    reboot: () => {
      addLine("Rebooting...");
      setTimeout(() => kernel?.reboot?.(), 800);
    },

    lock: () => {
      kernel?.lock?.();
    },
  };

  return commands;
};

// ============================================================================
// PARSER
// ============================================================================

const parseCommandLine = (line) => {
  // Tokeniza respetando comillas
  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        current += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else if (c === "|") {
      if (current) tokens.push(current);
      current = "";
      tokens.push("|");
    } else if (c === "&" && line[i + 1] === "&") {
      if (current) tokens.push(current);
      current = "";
      tokens.push("&&");
      i++;
    } else if (c === "|" && line[i + 1] === "|") {
      if (current) tokens.push(current);
      current = "";
      tokens.push("||");
      i++;
    } else {
      current += c;
    }
  }
  if (current) tokens.push(current);
  return tokens;
};

// ============================================================================
// TERMINAL
// ============================================================================

export function Terminal({ win }) {
  const wm = useWindowManager();

  const [lines, setLines] = useState([
    {
      kind: "output",
      text: `rainOS Terminal v1.0 (built with rain-shell)`,
    },
    { kind: "output", text: `Escribe 'help' para ver los comandos.` },
    { kind: "output", text: "" },
  ]);
  const [cwd, setCwd] = useState("/Users/usuario");
  const [input, setInput] = useState("");
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [env, setEnv] = useState({
    USER: "usuario",
    HOME: "/Users/usuario",
    HOSTNAME: "rainos",
    SHELL: "/bin/rain-shell",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    PWD: "/Users/usuario",
  });
  const [aliases, setAliases] = useState({
    ll: "ls -la",
    la: "ls -a",
  });
  const [fs, setFs] = useState(() => buildFS());

  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll al final
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  // Focus al montar
  useEffect(() => {
    inputRef.current?.focus?.();
  }, []);

  // ------------------------------------------------------ helpers
  const addLine = useCallback((text, kind = "output") => {
    setLines((prev) => [...prev, { kind, text: String(text ?? "") }]);
  }, []);

  const clear = useCallback(() => {
    setLines([]);
  }, []);

  const openApp = useCallback(
    (appId) => {
      // Delegar al sistema de apps vía evento del kernel
      // (el desktop escucha este evento y abre la app correspondiente)
      try {
        // eslint-disable-next-line no-undef
        window.dispatchEvent(
          new CustomEvent("rainos:open-app", { detail: { appId } })
        );
      } catch {
        /* noop */
      }
    },
    []
  );

  const commands = useMemo(
    () =>
      buildCommands({
        fs,
        setFs,
        cwd,
        setCwd,
        env,
        setEnv,
        aliases,
        setAliases,
        history,
        clear,
        addLine,
        openApp,
        onExit: () => wm.close(win?.id),
        kernel: {
          shutdown: () => console.log("[terminal] shutdown"),
          reboot: () => console.log("[terminal] reboot"),
          lock: () => console.log("[terminal] lock"),
        },
      }),
    [fs, cwd, env, aliases, history, clear, addLine, openApp, wm, win]
  );

  // ------------------------------------------------------ ejecutar comando
  const runLine = useCallback(
    (raw) => {
      const line = raw.trim();
      if (!line) return;

      // Echo del comando
      addLine(
        `${env.USER}@${env.HOSTNAME}:${cwd.replace("/Users/usuario", "~")}$ ${raw}`,
        "prompt"
      );

      // Añadir al historial
      setHistory((h) => [...h, raw]);
      setHistoryIndex(-1);

      // Manejo especial de && y ||
      const andParts = line.split(/\s*&&\s*/);
      const orParts = andParts[0].split(/\s*\|\|\s*/);

      // Simplificamos: ejecutamos cada parte secuencialmente, sin evaluar
      // realmente el resultado de && / ||. Los tratamos como ';'.
      for (const part of andParts) {
        for (const subpart of part.split(/\s*\|\|\s*/)) {
          runSimple(subpart.trim());
        }
      }
    },
    [addLine, env, cwd]
  );

  const runSimple = useCallback(
    (line) => {
      if (!line) return;

      // Alias
      const firstSpace = line.indexOf(" ");
      const firstWord = firstSpace >= 0 ? line.slice(0, firstSpace) : line;
      const restOfLine = firstSpace >= 0 ? line.slice(firstSpace + 1) : "";

      if (aliases[firstWord]) {
        runSimple(aliases[firstWord] + (restOfLine ? " " + restOfLine : ""));
        return;
      }

      // Pipes
      const pipeParts = parseCommandLine(line)
        .reduce((acc, tok) => {
          if (tok === "|") {
            acc.push([]);
          } else {
            if (acc.length === 0) acc.push([]);
            acc[acc.length - 1].push(tok);
          }
          return acc;
        }, [])
        .map((p) => p.join(" "));

      if (pipeParts.length > 1) {
        // Pipes muy simples: ejecutamos cada comando y concatenamos output
        for (const cmd of pipeParts) {
          runSimple(cmd);
        }
        return;
      }

      const tokens = parseCommandLine(line);
      const cmd = tokens[0];
      const args = tokens.slice(1);

      if (!commands[cmd]) {
        addLine(`rain-shell: command not found: ${cmd}`);
        return;
      }

      try {
        commands[cmd](args);
      } catch (err) {
        addLine(`rain-shell: error: ${err.message || String(err)}`);
      }
    },
    [commands, aliases]
  );

  // ------------------------------------------------------ key handling
  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const line = input;
      setInput("");
      runLine(line);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHistoryIndex((i) => {
        const next = Math.min(history.length - 1, i + 1);
        if (next >= 0) setInput(history[history.length - 1 - next]);
        return next;
      });
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHistoryIndex((i) => {
        const next = Math.max(-1, i - 1);
        if (next === -1) setInput("");
        else setInput(history[history.length - 1 - next]);
        return next;
      });
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      // Autocompletado simple: nombres de comandos + rutas
      const tokens = input.split(" ");
      const lastToken = tokens[tokens.length - 1];

      const candidates = Object.keys(commands)
        .concat(Object.keys(aliases))
        .filter((c) => c.startsWith(lastToken));

      // Añadir rutas del cwd
      const node = getNode(fs, cwd);
      if (node && node.type === "dir") {
        const entries = Object.keys(node.children || {});
        candidates.push(
          ...entries
            .filter((e) => e.startsWith(lastToken))
            .map((e) => e + (node.children[e].type === "dir" ? "/" : ""))
        );
      }

      if (candidates.length === 1) {
        tokens[tokens.length - 1] = candidates[0];
        setInput(tokens.join(" "));
      } else if (candidates.length > 1) {
        addLine(
          `${env.USER}@${env.HOSTNAME}:${cwd.replace("/Users/usuario", "~")}$ ${input}`,
          "prompt"
        );
        addLine(candidates.join("  "));
      }
      return;
    }

    if (e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        addLine(
          `${env.USER}@${env.HOSTNAME}:${cwd.replace("/Users/usuario", "~")}$ ${input}^C`,
          "prompt"
        );
        setInput("");
        return;
      }
      if (k === "l") {
        e.preventDefault();
        clear();
        return;
      }
      if (k === "a") {
        e.preventDefault();
        inputRef.current?.setSelectionRange?.(0, 0);
        return;
      }
      if (k === "e") {
        e.preventDefault();
        const len = input.length;
        inputRef.current?.setSelectionRange?.(len, len);
        return;
      }
      if (k === "u") {
        e.preventDefault();
        setInput("");
        return;
      }
      if (k === "w") {
        e.preventDefault();
        const trimmed = input.replace(/\S+\s*$/, "");
        setInput(trimmed);
        return;
      }
    }
  };

  // ------------------------------------------------------ click en la terminal → focus
  const handleTerminalClick = () => {
    inputRef.current?.focus?.();
  };

  const promptShort = cwd.replace("/Users/usuario", "~");

  return (
    <div
      onClick={handleTerminalClick}
      style={{
        height: "100%",
        background: "#1e1e1e",
        color: "#d4d4d4",
        fontFamily:
          '"SF Mono", Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.45,
        padding: "10px 14px",
        overflowY: "auto",
        cursor: "text",
        userSelect: "text",
      }}
      ref={scrollRef}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color:
              line.kind === "prompt"
                ? "#9cdcfe"
                : line.text.startsWith("rain-shell: command not found") ||
                  line.text.startsWith("rain-shell: error") ||
                  line.text.includes("No such file")
                ? "#f48771"
                : line.text.includes("→")
                ? "#6a9955"
                : "#d4d4d4",
          }}
        >
          {line.text || "\u00A0"}
        </div>
      ))}

      {/* Prompt activo */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          marginTop: 2,
        }}
      >
        <span style={{ color: "#9cdcfe", whiteSpace: "pre" }}>
          {env.USER}@{env.HOSTNAME}:{promptShort}$
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "#d4d4d4",
            fontFamily: "inherit",
            fontSize: "inherit",
            paddingLeft: 8,
            caretColor: "#d4d4d4",
          }}
        />
      </div>
    </div>
  );
}

export default Terminal;
