import { SchedulerProvider, useScheduler } from "rainOS";
import { VcpuProvider } from "rainOS/vcpu";

function App() {
  return (
    <SchedulerProvider autoStart>
      <Bridge />
    </SchedulerProvider>
  );
}

function Bridge() {
  const scheduler = useScheduler();
  return (
    <VcpuProvider scheduler={scheduler.scheduler} options={{ id: 0 }}>
      <RestoDelSistema />
    </VcpuProvider>
  );
}
