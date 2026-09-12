import { SecurityManager, installSecurityHooks } from "rainOS/security";

function BootstrapSecurity() {
  const { dyld, launcher } = useDyld(); // o como lo tengas montado

  const security = useMemo(() => new SecurityManager(), []);

  useEffect(() => {
    installSecurityHooks({
      security,
      dyld: dyld?.dyld,
      launcher: launcher?.launcher,
    });

    // Bloquear FileVault al arrancar
    security.fileVault.enable();
    security.fileVault.setPassword("contraseña-de-usuario");
    security.keychain.lock();

    // Instalar política MAC por defecto
    security.mac.registerPolicy(/* ... */);
  }, []);

  return null;
}

// Y en tu App:
<BootstrapSecurity />
