export type PlaybackIntent = Readonly<{
  viewer_id: string;
  plan_generation: number;
}>;

/** A mounted player owns one viewer identity. Intent is allocated before any
 * asynchronous work; cancelled probes may leave gaps, never reused numbers.
 * Retries reuse the immutable intent, while rebuild/audio/fallback call next(). */
export class PlaybackPlanGenerations {
  private generation = 0;
  constructor(private readonly viewer: string = crypto.randomUUID()) {}

  /** A decode child must pass its synchronous proposal before retiring its
   * parent's generation. Rejected proposals never advance local authority. */
  nextWhen(
    accept: (intent: PlaybackIntent) => boolean,
  ): PlaybackIntent | undefined {
    if (this.generation >= 0xffff_ffff)
      throw new Error("播放方案代次已用尽，请重新打开播放器");
    const intent = Object.freeze({
      viewer_id: this.viewer,
      plan_generation: this.generation + 1,
    });
    if (!accept(intent)) return;
    ++this.generation;
    return intent;
  }

  next(): PlaybackIntent {
    if (this.generation >= 0xffff_ffff)
      throw new Error("播放方案代次已用尽，请重新打开播放器");
    return Object.freeze({
      viewer_id: this.viewer,
      plan_generation: ++this.generation,
    });
  }

  current(plan: { plan_generation?: number }): boolean {
    return this.generation > 0 && plan.plan_generation === this.generation;
  }
}

export function matchesPlanGeneration(
  expected: number | undefined,
  actual: number | undefined,
): boolean {
  return (
    expected === undefined ||
    (Number.isInteger(expected) &&
      expected > 0 &&
      expected <= 0xffff_ffff &&
      actual === expected)
  );
}
