import type { PacketEnvelope } from '../protocol/packets.js';

export interface HubClient {
  connect(): Promise<void>;
  register(agentId: string): Promise<void>;
  disconnect(): Promise<void>;
  heartbeat(): Promise<void>;
  claimQuestion(): Promise<{ envelope: PacketEnvelope | null }>;
  submitAnswer(envelope: PacketEnvelope): Promise<void>;
  submitEscalation(envelope: PacketEnvelope): Promise<void>;
  readonly isRegistered: boolean;
}
