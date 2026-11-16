"use client";
import { AlertPanel } from "@/components/panels";
import { useApp } from "@/components/shell";

export default function AlertsPage() {
  const { live, now } = useApp();
  const d = live.dashboard;
  if (!d) return <p className="p-6 text-sm text-muted">Connecting to the home PC…</p>;
  return (
    <main className="flex min-h-0 flex-1 flex-col p-3 lg:mx-auto lg:w-full lg:max-w-3xl">
      <AlertPanel alerts={d.alerts} now={now} />
    </main>
  );
}
