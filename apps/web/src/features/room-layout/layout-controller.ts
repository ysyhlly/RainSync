import {
  computed,
  getCurrentScope,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from "vue";
import {
  createDefaultLayout,
  validateLayout,
  type LayoutBreakpoint,
  type LayoutDocument,
  type WidgetType,
} from "./layout-model";
import {
  addWidget,
  moveWidget,
  removeWidget,
  resizeWidget,
} from "./layout-geometry";
import {
  copyLayoutGeometry,
  loadRoomLayout,
  saveRoomLayout,
  type LayoutLoadStatus,
  type LayoutStorage,
} from "./layout-storage";

export const MAX_LAYOUT_HISTORY = 50;

export interface RoomLayoutOptions {
  userId: MaybeRefOrGetter<string | null | undefined>;
  breakpoint: MaybeRefOrGetter<LayoutBreakpoint>;
  storage?: LayoutStorage | null;
}

interface LayoutEditSnapshot {
  layout: LayoutDocument;
  resetRequested: boolean;
}

function immutableSnapshot(layout: LayoutDocument): LayoutDocument {
  const snapshot = copyLayoutGeometry(layout);
  // Computed refs protect replacement; freezing also protects nested geometry.
  for (const item of snapshot.items) Object.freeze(item);
  Object.freeze(snapshot.items);
  return Object.freeze(snapshot);
}

function sameLayout(left: LayoutDocument, right: LayoutDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A single local edit transaction, scoped to the current account and viewport. */
export function useRoomLayout(options: RoomLayoutOptions) {
  const committedState = shallowRef<LayoutDocument>(
    immutableSnapshot(createDefaultLayout(toValue(options.breakpoint))),
  );
  const draftState = shallowRef<LayoutDocument | null>(null);
  const editingState = ref(false);
  const resetRequested = ref(false);
  const past = shallowRef<LayoutEditSnapshot[]>([]);
  const future = shallowRef<LayoutEditSnapshot[]>([]);
  const actionError = ref<string | null>(null);
  const storageError = ref<string | null>(null);
  const loadStatus = ref<LayoutLoadStatus>("default");
  const saveFailed = ref(false);
  let scopeUserId: string | null | undefined;
  let scopeBreakpoint: LayoutBreakpoint = toValue(options.breakpoint);
  let disposed = false;
  let scopeLoadError: string | null = null;

  function clearTransaction() {
    draftState.value = null;
    editingState.value = false;
    resetRequested.value = false;
    past.value = [];
    future.value = [];
    actionError.value = null;
    saveFailed.value = false;
  }

  const stopWatching = watch(
    [() => toValue(options.userId), () => toValue(options.breakpoint)],
    ([userId, breakpoint]) => {
      // Flush synchronously: a same-tick Done click cannot write the old user's
      // draft into the newly signed-in account or into a different breakpoint.
      scopeUserId = userId;
      scopeBreakpoint = breakpoint;
      clearTransaction();
      const loaded = loadRoomLayout(userId, breakpoint, options.storage);
      committedState.value = immutableSnapshot(loaded.layout);
      loadStatus.value = loaded.status;
      scopeLoadError = loaded.error;
      storageError.value = loaded.error;
    },
    { immediate: true, flush: "sync" },
  );

  const layout = computed(() => draftState.value ?? committedState.value);
  const committed = computed(() => committedState.value);
  const draft = computed(() => draftState.value);
  const editing = computed(() => editingState.value);
  const dirty = computed(
    () =>
      draftState.value !== null &&
      (resetRequested.value ||
        !sameLayout(draftState.value, committedState.value)),
  );
  const canUndo = computed(() => editingState.value && past.value.length > 0);
  const canRedo = computed(() => editingState.value && future.value.length > 0);
  const error = computed(() => storageError.value ?? actionError.value);
  const status = computed(() => {
    if (saveFailed.value) return "布局尚未保存，可重试或取消";
    if (dirty.value) return "有未保存的布局更改";
    if (editingState.value) return "正在编辑布局";
    if (loadStatus.value === "memory-only") return "访客布局仅在本次访问中保留";
    if (storageError.value) return "当前使用默认布局";
    return "布局仅保存在当前浏览器";
  });

  function begin(): boolean {
    if (disposed || editingState.value) return false;
    draftState.value = immutableSnapshot(committedState.value);
    editingState.value = true;
    resetRequested.value = false;
    past.value = [];
    future.value = [];
    actionError.value = null;
    return true;
  }

  function cancel(): boolean {
    if (disposed || !editingState.value) return false;
    clearTransaction();
    // Preserve load warnings, but a failed save no longer has a pending draft.
    storageError.value = scopeLoadError;
    return true;
  }

  function currentSnapshot(): LayoutEditSnapshot {
    return { layout: draftState.value!, resetRequested: resetRequested.value };
  }

  function updateDraft(
    next: LayoutDocument,
    reset = resetRequested.value,
  ): boolean {
    if (disposed || !editingState.value || !draftState.value) return false;
    if (!validateLayout(next, scopeBreakpoint).valid) {
      actionError.value = "该布局不可用，请选择其他位置或尺寸";
      return false;
    }
    if (sameLayout(next, draftState.value) && reset === resetRequested.value)
      return false;
    past.value = [...past.value, currentSnapshot()].slice(-MAX_LAYOUT_HISTORY);
    future.value = [];
    draftState.value = immutableSnapshot(next);
    resetRequested.value = reset;
    actionError.value = null;
    return true;
  }

  function applyGeometry(
    operation: (document: LayoutDocument) => LayoutDocument,
  ): boolean {
    if (disposed || !editingState.value || !draftState.value) return false;
    const current = draftState.value;
    const next = operation(current);
    if (next === current || sameLayout(next, current)) {
      actionError.value = "无法应用该更改，请选择其他位置或尺寸";
      return false;
    }
    return updateDraft(next);
  }

  function commit(): boolean {
    if (disposed || !editingState.value || !draftState.value) return false;
    if (!dirty.value) {
      storageError.value = scopeLoadError;
      clearTransaction();
      return true;
    }
    const next = draftState.value;
    const result = saveRoomLayout(scopeUserId, next, options.storage, {
      replaceUnsupportedVersion: resetRequested.value,
    });
    if (!result.ok) {
      storageError.value = result.error;
      saveFailed.value = true;
      return false;
    }
    // Only a successful write (or explicitly memory-only guest scope) promotes
    // the complete draft. Failure never partially commits or clears history.
    committedState.value = immutableSnapshot(next);
    scopeLoadError = null;
    storageError.value = null;
    loadStatus.value = result.persisted ? "saved" : "memory-only";
    clearTransaction();
    return true;
  }

  function reset(): boolean {
    return updateDraft(createDefaultLayout(scopeBreakpoint), true);
  }

  function add(type: WidgetType): boolean {
    return applyGeometry((document) => addWidget(document, type));
  }

  function remove(id: string): boolean {
    return applyGeometry((document) => removeWidget(document, id));
  }

  function move(id: string, x: number, y: number): boolean {
    return applyGeometry((document) => moveWidget(document, id, x, y));
  }

  function resize(id: string, w: number, h: number): boolean {
    return applyGeometry((document) => resizeWidget(document, id, w, h));
  }

  function undo(): boolean {
    if (disposed || !canUndo.value || !draftState.value) return false;
    const previous = past.value.at(-1)!;
    past.value = past.value.slice(0, -1);
    future.value = [...future.value, currentSnapshot()];
    draftState.value = previous.layout;
    resetRequested.value = previous.resetRequested;
    actionError.value = null;
    return true;
  }

  function redo(): boolean {
    if (disposed || !canRedo.value || !draftState.value) return false;
    const next = future.value.at(-1)!;
    future.value = future.value.slice(0, -1);
    past.value = [...past.value, currentSnapshot()].slice(-MAX_LAYOUT_HISTORY);
    draftState.value = next.layout;
    resetRequested.value = next.resetRequested;
    actionError.value = null;
    return true;
  }

  function dispose() {
    stopWatching();
    clearTransaction();
    disposed = true;
  }
  if (getCurrentScope()) onScopeDispose(dispose);

  return {
    layout,
    committed,
    draft,
    editing,
    dirty,
    canUndo,
    canRedo,
    error,
    status,
    begin,
    cancel,
    commit,
    reset,
    add,
    remove,
    move,
    resize,
    undo,
    redo,
    dispose,
  };
}

export type RoomLayoutController = ReturnType<typeof useRoomLayout>;
