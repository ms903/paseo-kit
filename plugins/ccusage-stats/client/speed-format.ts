import type { SessionSpeedSample } from "../shared/speed";

const BASIS_PRIORITY: Record<SessionSpeedSample["basis"], number> = {
  decode: 0,
  response: 1,
  "model-time": 2,
  "whole-turn": 3,
};

export function hasMeasuredSpeed(sample: SessionSpeedSample | undefined): sample is SessionSpeedSample {
  return !!sample && Number.isFinite(sample.tokensPerSecond) && sample.tokensPerSecond > 0;
}

export function groupTurnSpeeds(samples: readonly SessionSpeedSample[]): SessionSpeedSample[][] {
  const turns = new Map<string, SessionSpeedSample[]>();
  for (const sample of samples) {
    if (!hasMeasuredSpeed(sample)) continue;
    const previous = turns.get(sample.turnId);
    if (!previous) turns.set(sample.turnId, [sample]);
    else if (!previous.some(({ basis, source }) => basis === sample.basis && source === sample.source)) previous.push(sample);
  }
  return [...turns.values()].map((turn) => turn.sort((a, b) => BASIS_PRIORITY[a.basis] - BASIS_PRIORITY[b.basis]));
}

export function formatRate(rate: number, locale: string): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return rate < 0.1 ? `<${number.format(0.1)}` : number.format(rate);
}
