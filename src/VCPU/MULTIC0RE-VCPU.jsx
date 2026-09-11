const NUM_CORES = 4;

export function MultiVcpuProvider({ scheduler, children }) {
  const vcpus = useMemo(
    () => Array.from({ length: NUM_CORES }, (_, i) => new VCPU({ id: i, scheduler })),
    [scheduler]
  );

  useEffect(() => {
    // Asignar cada VCPU a un core del scheduler
    scheduler.cores.forEach((core, i) => {
      core.vcpu = vcpus[i];
    });

    // Redefinir _runUserThread para que use el VCPU del core donde corre
    const original = scheduler._runUserThread;
    scheduler._runUserThread = async (thread) => {
      const core = scheduler.cores.find((c) => c.id === thread.coreId) || scheduler.cores[0];
      const vcpu = core.vcpu;
      vcpu.runQuantum(thread, 500);
    };
  }, [scheduler, vcpus]);

  return <>{children}</>;
}
