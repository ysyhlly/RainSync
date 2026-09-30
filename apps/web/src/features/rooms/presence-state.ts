/** Internal view model; the protocol adapter is installed after contract approval. */
export interface OnlineMember {
  userId: string;
  connections: number;
}
export interface OnlineSnapshot {
  roomId: string;
  epoch: string;
  sequence: number;
  members: OnlineMember[];
}
export type PresenceResult = "applied" | "ignored" | "resync";

/** Each socket callback must capture the generation returned by begin(). */
export class PresenceState {
  private generation = 0;
  private roomId = "";
  private connectionId: string | undefined;
  private snapshot: OnlineSnapshot | undefined;

  begin(roomId: string): number {
    this.generation++;
    this.roomId = roomId;
    this.connectionId = undefined;
    this.snapshot = undefined;
    return this.generation;
  }

  /** Disconnect/leave clear online claims synchronously, before any async work. */
  end(generation: number): void {
    if (generation !== this.generation) return;
    this.begin("");
  }

  get current(): OnlineSnapshot | undefined {
    return this.snapshot && this.copy(this.snapshot);
  }

  bind(
    generation: number,
    connectionId: string,
    value: OnlineSnapshot,
  ): PresenceResult {
    if (
      generation !== this.generation ||
      this.connectionId ||
      !connectionId ||
      !this.valid(value)
    )
      return "ignored";
    this.connectionId = connectionId;
    this.snapshot = this.copy(value);
    return "applied";
  }

  accept(generation: number, value: OnlineSnapshot): PresenceResult {
    if (
      generation !== this.generation ||
      !this.connectionId ||
      !this.snapshot ||
      !this.valid(value)
    )
      return "ignored";
    if (value.epoch !== this.snapshot.epoch) {
      // A new epoch must be established by a new authenticated socket handshake.
      // Never let a late old epoch become the current epoch merely by arriving.
      this.end(generation);
      return "resync";
    }
    if (value.sequence <= this.snapshot.sequence) return "ignored";
    this.snapshot = this.copy(value);
    return "applied";
  }

  private copy(value: OnlineSnapshot): OnlineSnapshot {
    return {
      ...value,
      members: value.members.map((member) => ({ ...member })),
    };
  }

  private valid(value: OnlineSnapshot): boolean {
    return (
      !!value &&
      value.roomId === this.roomId &&
      !!value.roomId &&
      typeof value.epoch === "string" &&
      value.epoch.length > 0 &&
      Number.isInteger(value.sequence) &&
      value.sequence >= 0 &&
      value.sequence <= 0xffffffff &&
      Array.isArray(value.members) &&
      value.members.length <= 80 &&
      value.members.every(
        (member) =>
          !!member &&
          typeof member.userId === "string" &&
          member.userId.length > 0 &&
          Number.isInteger(member.connections) &&
          member.connections > 0 &&
          member.connections <= 8,
      ) &&
      new Set(value.members.map((member) => member.userId)).size ===
        value.members.length &&
      value.members.reduce((sum, member) => sum + member.connections, 0) <= 80
    );
  }
}
