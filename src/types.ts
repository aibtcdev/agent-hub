export type Agent = {
  id: string;
  name: string;
  bns_name: string | null;
  bitcoin_address: string | null;
  capabilities: string | null;
  endpoint_url: string | null;
  registered_at: string;
  last_seen: string | null;
};

export type Task = {
  id: string;
  from_agent: string;
  to_agent: string;
  subject: string;
  payload: string | null;
  status: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
};

export interface DbClient {
  insertAgent(agent: Omit<Agent, "registered_at" | "last_seen">): Promise<void>;
  getAgent(id: string): Promise<Agent | null>;
  listAgents(): Promise<Agent[]>;
  listAgentsByCapability(cap: string): Promise<Agent[]>;
  touchAgent(id: string): Promise<void>;
  insertTask(
    task: Omit<Task, "status" | "result" | "created_at" | "completed_at">
  ): Promise<void>;
  getTask(id: string): Promise<Task | null>;
  listTasksForAgent(agentId: string): Promise<Task[]>;
  listTasksForAgentByStatus(agentId: string, status: string): Promise<Task[]>;
  completeTask(id: string, status: string, result: string | null): Promise<void>;
}
