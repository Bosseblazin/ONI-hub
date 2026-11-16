/**
 * Colony Operations domain model: the commander ↔ Claude layer that sits on top of read-only monitoring.
 * Everything here is persisted on the home PC (data/ops/*).
 */

export type PriorityLevel = 1 | 2 | 3 | 4 | 5;
export const PRIORITY_LABELS: Record<PriorityLevel, string> = {
  1: "Emergency",
  2: "Critical",
  3: "High",
  4: "Normal",
  5: "Deferred",
};

export type ObjectiveStatus = "proposed" | "active" | "blocked" | "paused" | "completed" | "cancelled";

/** Machine-checkable completion criterion, evaluated against live snapshots. */
export interface Criterion {
  metric: CriterionMetric;
  /** World the metric applies to; null = whole colony (summed / worst case as defined per metric). */
  worldId: number | null;
  op: ">=" | "<=";
  value: number;
}

export type CriterionMetric =
  | "foodRunwayCycles"
  | "oxygenKgPerDupe"
  | "batteryPct"
  | "powerHeadroomW"
  | "waterKg"
  | "coalKg"
  | "incapacitated"
  | "starving"
  | "maxStressPct"
  | "generatorsOperational"
  | "population"
  | "activeCriticalAlerts";

export interface ObjectiveEvent {
  at: number;
  by: "commander" | "claude" | "agent" | "system";
  note: string;
}

export interface Objective {
  id: string;
  title: string;
  description: string;
  /** Target world id; null = colony-wide. */
  worldId: number | null;
  worldName: string | null;
  priority: PriorityLevel;
  status: ObjectiveStatus;
  createdAt: number;
  updatedAt: number;
  createdBy: "commander" | "claude" | "agent";
  /** Human-readable completion criteria. */
  completionCriteria: string;
  /** Optional machine-checkable criteria; all must hold for completion. */
  criteria: Criterion[];
  dependencies: string[];
  constraints: string[];
  /** 0-100, from criteria when available, else from Claude's last assessment; null = unknown. */
  progress: number | null;
  progressNote: string | null;
  /** Consecutive evaluations with all criteria met (completion needs persistence). */
  metStreak: number;
  sourceCommandId: string | null;
  history: ObjectiveEvent[];
}

export type OperatingMode = "survival" | "stabilization" | "expansion" | "exploration" | "commander";

export interface ModeState {
  mode: OperatingMode;
  setBy: "commander" | "default";
  setAt: number;
  note: string | null;
}

export type PermissionLevel = 1 | 2 | 3;
export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
  1: "Observation",
  2: "Supervised execution",
  3: "Authorized autonomy",
};

/* ------------------------------------------------------------------ commands */

export type CommandType =
  | "instruction"
  | "mode.set"
  | "objective.update"
  | "objective.create"
  | "recommendation.decide"
  | "proposal.decide"
  | "permission.set"
  | "notifications.update"
  | "investigation.request"
  | "report.request"
  | "settings.update"
  | "alert.ack"
  | "alert.dismiss";

export type CommandStatus = "received" | "processing" | "completed" | "failed" | "deferred";

export interface Command {
  /** Server-side sequence number (monotonic). */
  seq: number;
  /** Client-generated idempotency key. Same key → same command; never processed twice. */
  clientId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  /** Device/session label that submitted it. */
  issuedBy: string;
  clientCreatedAt: number | null;
  receivedAt: number;
  processedAt: number | null;
  status: CommandStatus;
  result: string | null;
  error: string | null;
}

/* ------------------------------------------------------------------ messages */

export type InstructionKind =
  | "strategic_instruction"
  | "information_request"
  | "recommendation_request"
  | "action_permission"
  | "mode_change"
  | "acknowledgement"
  | "unclear";

export interface Message {
  id: string;
  at: number;
  from: "commander" | "claude" | "system";
  text: string;
  commandClientId: string | null;
  kind: InstructionKind | "report" | "investigation" | "notice" | null;
  /** True when produced without Claude (offline fallback / simulator). */
  degraded?: boolean;
  objectiveIds?: string[];
}

/* -------------------------------------------------------------- investigations */

export interface Finding {
  statement: string;
  basis: "observed" | "derived" | "assumption";
}

export interface Investigation {
  id: string;
  topic: string;
  worldId: number | null;
  worldName: string | null;
  trigger: "alert" | "commander" | "objective" | "periodic";
  triggerRef: string | null;
  status: "open" | "analyzing" | "concluded" | "blocked";
  openedAt: number;
  updatedAt: number;
  summary: string | null;
  findings: Finding[];
  recommendations: string[];
  /** Raw evidence gathered from read-only resources (kept small). */
  evidence: Record<string, unknown>;
  blockedReason: string | null;
}

/* ------------------------------------------------- recommendations & proposals */

/** A strategic change Claude suggests but may not apply on its own (mode change, objective reprioritisation). */
export interface Recommendation {
  id: string;
  at: number;
  kind: "mode_change" | "objective_change" | "plan_revision";
  title: string;
  rationale: string;
  conflict: string | null;
  /** Mode to switch to (mode_change). */
  mode?: OperatingMode;
  /** Objective changes to apply if accepted. */
  objectiveChanges?: Array<{ id: string; priority?: PriorityLevel; status?: ObjectiveStatus }>;
  status: "pending" | "accepted" | "declined" | "superseded";
  decidedAt: number | null;
}

export type ActionRisk = "routine" | "elevated" | "destructive" | "critical";
export type ActionCategory =
  | "priorities"
  | "schedules"
  | "research"
  | "construction"
  | "deconstruction"
  | "dig"
  | "duplicant_assignment"
  | "printing_pod"
  | "rocketry"
  | "game_speed"
  | "other";

export type ProposalStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "executed"
  | "verified"
  | "failed";

/** A concrete game action. In v1 these can be proposed and approved, but never executed. */
export interface ActionProposal {
  id: string;
  at: number;
  title: string;
  rationale: string;
  category: ActionCategory;
  risk: ActionRisk;
  worldId: number | null;
  objectiveId: string | null;
  /** What the commander should do manually while execution is disabled. */
  manualSteps: string[];
  status: ProposalStatus;
  decidedAt: number | null;
  decidedBy: string | null;
  executionNote: string | null;
}

/* --------------------------------------------------------------- notifications */

export type NotificationCategory =
  | "food"
  | "starvation"
  | "oxygen"
  | "power"
  | "water"
  | "temperature"
  | "health"
  | "ai_unresolved"
  | "game_disconnected"
  | "instruction_received"
  | "instruction_completed"
  | "investigation"
  | "status_report";

export interface NotificationPrefs {
  enabled: boolean;
  /** Minimum alert severity that may notify. */
  minSeverity: "CRITICAL" | "WARNING" | "INFO";
  categories: Record<NotificationCategory, boolean>;
  /** Minutes before the same alert/category can notify again (escalations bypass). */
  cooldownMinutes: number;
  /** Quiet hours in local time (HH:MM). CRITICAL still notifies. */
  quietStart: string | null;
  quietEnd: string | null;
}

export interface NotificationRecord {
  id: string;
  at: number;
  category: NotificationCategory;
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: string;
  body: string;
  key: string;
  channels: Record<string, "sent" | "failed" | "skipped">;
}

/* ------------------------------------------------------------------- settings */

export interface AgentSettings {
  /** Minimum minutes between unprompted Claude analyses (cost guard). */
  analysisIntervalMinutes: number;
  /** Hard cap on Claude calls per rolling hour. */
  maxClaudeCallsPerHour: number;
  /** Minutes between automatic status reports while the commander asked to be kept updated. */
  statusReportMinutes: number;
  keepCommanderUpdated: boolean;
  screenshotIntervalMinutes: number; // 0 = disabled
}

/* ------------------------------------------------------------------- AI status */

export interface Decision {
  at: number;
  summary: string;
  reasoning: string;
  basis: "commander" | "alert" | "objective" | "mode" | "periodic";
}

export interface AgentStatus {
  running: boolean;
  startedAt: number;
  lastTickAt: number | null;
  lastClaudeSuccessAt: number | null;
  lastClaudeError: string | null;
  claudeAvailable: boolean;
  claudeCallsLastHour: number;
  currentInvestigationId: string | null;
  queueDepth: number;
}

export interface HomeStatus {
  /** The home server answered this request, so the PC is online by definition. */
  pcOnline: true;
  hostname: string;
  uptimeSeconds: number;
  gameProcess: "running" | "stopped" | "unknown";
  colonyLoaded: boolean;
  oniMcp: "connected" | "disconnected" | "game-not-loaded" | "connecting" | "error";
  claude: "available" | "unconfigured" | "error";
  lastObservationAt: number | null;
  lastHeartbeatAt: number | null;
  heartbeatConfigured: boolean;
  remoteAccess: { passphraseSet: boolean; sessions: number };
  /** Outbound link to the cloud relay (cloud deployments only). */
  relay: { url: string; connected: boolean; lastSyncAt: number | null; lastError: string | null; consecutiveFailures: number } | null;
  serverTime: number;
}

export interface OpsState {
  mode: ModeState;
  permissionLevel: PermissionLevel;
  executionLayerEnabled: false;
  objectives: Objective[];
  messages: Message[];
  investigations: Investigation[];
  recommendations: Recommendation[];
  proposals: ActionProposal[];
  decisions: Decision[];
  commands: Command[];
  notifications: NotificationRecord[];
  notificationPrefs: NotificationPrefs;
  agentSettings: AgentSettings;
  agent: AgentStatus;
  home: HomeStatus;
}
