"use client";
import { AgentSettingsPanel, AuditPanel, HomeStatusPanel, NotificationSettings, PermissionPanel, SessionsPanel } from "@/components/home-ui";
import { useApp } from "@/components/shell";

export default function SettingsPage() {
  const { live } = useApp();
  const ops = live.ops;
  return (
    <main className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2 xl:grid-cols-3">
      <div className="space-y-3">
        <HomeStatusPanel />
        {ops && <PermissionPanel ops={ops} />}
      </div>
      <div className="space-y-3">
        {ops && <NotificationSettings ops={ops} />}
        {ops && <AgentSettingsPanel ops={ops} />}
      </div>
      <div className="space-y-3">
        <SessionsPanel />
        <AuditPanel />
      </div>
    </main>
  );
}
