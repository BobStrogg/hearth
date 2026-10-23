// The one place Hearth imports the ACP SDK. SDK 2 removed ClientSideConnection; this keeps Hearth's call sites
// (initialize/newSession/loadSession/... on a connection object) on top of the SDK's client app API.
// Hearth uses unstable v1 features (session/list, session/resume, config options, set_model), so it imports the
// SDK's /unstable entrypoint: same wire protocol (ACP v1) and the same feature set the 1.x SDK exposed by default.
import * as acp from "@agentclientprotocol/sdk/unstable";
export * from "@agentclientprotocol/sdk/unstable";

type P<M extends acp.ClientRequestMethod> = acp.ClientRequestParamsByMethod[M];
type R<M extends acp.ClientRequestMethod> = Promise<acp.ClientRequestResponsesByMethod[M] | void>;
/** What the agent may ask of Hearth. Methods left out answer "method not found". */
export interface ClientHandlers {
  requestPermission(p: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  sessionUpdate?(p: acp.SessionNotification): Promise<void> | void;
  readTextFile?(p: P<"fs/read_text_file">): R<"fs/read_text_file">;
  writeTextFile?(p: P<"fs/write_text_file">): R<"fs/write_text_file">;
  createTerminal?(p: P<"terminal/create">): R<"terminal/create">;
  terminalOutput?(p: P<"terminal/output">): R<"terminal/output">;
  waitForTerminalExit?(p: P<"terminal/wait_for_exit">): R<"terminal/wait_for_exit">;
  killTerminal?(p: P<"terminal/kill">): R<"terminal/kill">;
  releaseTerminal?(p: P<"terminal/release">): R<"terminal/release">;
}

const M = acp.methods;
const CLIENT_REQS = {
  readTextFile: M.client.fs.readTextFile, writeTextFile: M.client.fs.writeTextFile,
  createTerminal: M.client.terminal.create, terminalOutput: M.client.terminal.output, waitForTerminalExit: M.client.terminal.waitForExit,
  killTerminal: M.client.terminal.kill, releaseTerminal: M.client.terminal.release,
} as const;

/** Hearth's side of an ACP connection to an agent. */
export class AgentLink {
  readonly connection: acp.ClientConnection;
  constructor(handlers: ClientHandlers, stream: acp.Stream) {
    const app = acp.client({ name: "hearth" })
      .onRequest(M.client.session.requestPermission, ({ params }) => handlers.requestPermission(params))
      .onNotification(M.client.session.update, async ({ params }) => { await handlers.sessionUpdate?.(params); });
    for (const [k, method] of Object.entries(CLIENT_REQS) as [keyof typeof CLIENT_REQS, acp.ClientRequestMethod][]) {
      const h = handlers[k] as ((p: unknown) => Promise<unknown>) | undefined;
      if (h) app.onRequest(method as never, (({ params }: { params: unknown }) => h(params)) as never);
    }
    this.connection = app.connect(stream);
  }
  private get agent() { return this.connection.agent; }
  initialize(p: acp.InitializeRequest) { return this.agent.request(M.agent.initialize, p); }
  newSession(p: acp.NewSessionRequest) { return this.agent.request(M.agent.session.new, p); }
  loadSession(p: acp.LoadSessionRequest) { return this.agent.request(M.agent.session.load, p); }
  resumeSession(p: acp.ResumeSessionRequest) { return this.agent.request(M.agent.session.resume, p); }
  listSessions(p: acp.ListSessionsRequest) { return this.agent.request(M.agent.session.list, p); }
  prompt(p: acp.PromptRequest) { return this.agent.request(M.agent.session.prompt, p); }
  cancel(p: acp.CancelNotification) { return this.agent.notify(M.agent.session.cancel, p); }
  setSessionMode(p: acp.SetSessionModeRequest) { return this.agent.request(M.agent.session.setMode, p); }
  setSessionConfigOption(p: acp.SetSessionConfigOptionRequest) { return this.agent.request(M.agent.session.setConfigOption, p); }
  /** Any other (custom or newer) agent method, e.g. the pre-config-options `session/set_model`. */
  request<T = unknown>(method: string, params?: unknown) { return this.agent.request<T>(method, params); }
  close(err?: unknown) { this.connection.close(err); }
}

/** For quick probes: answers permission requests with "cancelled" and ignores updates. */
export const probeClient = (stream: acp.Stream) => new AgentLink({ requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }, stream);
