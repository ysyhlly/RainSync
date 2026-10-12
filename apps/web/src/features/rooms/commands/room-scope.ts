/** Exact request ownership; these independent generations are not a version. */
export type RoomRequestScope = Readonly<{
  owner: object;
  identity: number;
  room: string;
  roomGeneration: number;
  connectionGeneration: number;
}>;

export type RoomScopePort = {
  capture: () => RoomRequestScope | undefined;
  current: (scope: RoomRequestScope) => boolean;
  currentRoom: (scope: RoomRequestScope) => boolean;
};

export function createRoomScopePort(
  read: () => Omit<RoomRequestScope, "owner"> | undefined,
): RoomScopePort {
  const owner = Object.freeze({});
  const currentRoom = (scope: RoomRequestScope) => {
    const now = read();
    return (
      !!now &&
      scope.owner === owner &&
      now.identity === scope.identity &&
      now.room === scope.room &&
      now.roomGeneration === scope.roomGeneration
    );
  };
  return {
    capture: () => {
      const scope = read();
      return scope && Object.freeze({ ...scope, owner });
    },
    currentRoom,
    current: (scope) => {
      const now = read();
      return (
        !!now &&
        currentRoom(scope) &&
        now.connectionGeneration === scope.connectionGeneration
      );
    },
  };
}
