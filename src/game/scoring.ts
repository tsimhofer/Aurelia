import { Track } from '../providers/types';

export const MIN_SNIPPET_SECONDS = 0.1;
export const MAX_SNIPPET_SECONDS = 30.0;
export const MAX_BASE_SCORE = 10_000;
export const MIN_BASE_SCORE_AT_30S = 3_500;
export const WRONG_GUESS_PENALTY = 500;

export interface RoundGuess {
  trackId: string;
  title: string;
  artist: string;
  snippetDurationAtGuessSec: number;
  guessElapsedSec?: number;
  correct: boolean;
}

export interface CompletedRound {
  roundNumber: number;
  targetTrack: Track;
  status: 'won' | 'gave-up';
  unlockedDurationSec: number;
  guessElapsedSec?: number;
  startOffsetSec: number;
  wrongGuesses: number;
  guesses: RoundGuess[];
  pointsAwarded: number;
}

export interface RunRanking {
  tier: 'S+' | 'S' | 'A' | 'B' | 'C' | 'D';
  title: string;
  description: string;
  averagePointsPerRound: number;
  winRatePercent: number;
  averageDurationSec: number;
}

/**
 * Computes the base score along a logarithmic decay curve:
 * - 0.1s  -> 10,000 pts
 * - 30.0s -> 3,500 pts
 *
 * Formula:
 *   S(t) = 10000 - (10000 - 3500) * ln(t / 0.1) / ln(30 / 0.1)
 */
export function calculateLogarithmicBaseScore(durationSec: number): number {
  const clamped = Math.max(MIN_SNIPPET_SECONDS, Math.min(MAX_SNIPPET_SECONDS, durationSec));
  const normalizedLog =
    Math.log(clamped / MIN_SNIPPET_SECONDS) /
    Math.log(MAX_SNIPPET_SECONDS / MIN_SNIPPET_SECONDS);
  const rawScore =
    MAX_BASE_SCORE - (MAX_BASE_SCORE - MIN_BASE_SCORE_AT_30S) * normalizedLog;
  return Math.round(rawScore);
}

/**
 * Computes the net round points from the unlocked snippet duration (0.1s - 30s)
 * after deducting -500 pts per wrong guess. Points do not count down with time.
 */
export function calculateNetRoundScore(
  durationSec: number,
  wrongGuessesCount: number
): number {
  const base = calculateLogarithmicBaseScore(durationSec);
  const penalty = Math.max(0, wrongGuessesCount) * WRONG_GUESS_PENALTY;
  return Math.max(0, base - penalty);
}

/**
 * Evaluates an end-of-run ranking tier from completed rounds.
 */
export function evaluateRunRanking(rounds: CompletedRound[]): RunRanking {
  if (rounds.length === 0) {
    return {
      tier: 'D',
      title: 'Unranked Listener',
      description: 'Complete at least one round to earn your library mastery rank.',
      averagePointsPerRound: 0,
      winRatePercent: 0,
      averageDurationSec: 0,
    };
  }

  const totalScore = rounds.reduce((acc, r) => acc + r.pointsAwarded, 0);
  const wonRounds = rounds.filter((r) => r.status === 'won');
  const averagePointsPerRound = Math.round(totalScore / rounds.length);
  const winRatePercent = Math.round((wonRounds.length / rounds.length) * 100);
  const averageDurationSec =
    wonRounds.length > 0
      ? Number(
          (
            wonRounds.reduce((acc, r) => acc + r.unlockedDurationSec, 0) / wonRounds.length
          ).toFixed(2)
        )
      : MAX_SNIPPET_SECONDS;

  if (averagePointsPerRound >= 8800 && winRatePercent >= 90) {
    return {
      tier: 'S+',
      title: 'Omniscient Archivist',
      description: 'Instant recognition from splits of a second across your personal library.',
      averagePointsPerRound,
      winRatePercent,
      averageDurationSec,
    };
  }
  if (averagePointsPerRound >= 7200) {
    return {
      tier: 'S',
      title: 'sonic Virtuoso',
      description: 'Razor-sharp ear—most tracks identified within the opening transients.',
      averagePointsPerRound,
      winRatePercent,
      averageDurationSec,
    };
  }
  if (averagePointsPerRound >= 5500) {
    return {
      tier: 'A',
      title: 'Crate Digger',
      description: 'Deep familiarity with your collection with minimal scrubbing.',
      averagePointsPerRound,
      winRatePercent,
      averageDurationSec,
    };
  }
  if (averagePointsPerRound >= 4000) {
    return {
      tier: 'B',
      title: 'Rhythm Regular',
      description: 'Solid recall once the melody or groove kicks in.',
      averagePointsPerRound,
      winRatePercent,
      averageDurationSec,
    };
  }
  if (averagePointsPerRound >= 2000) {
    return {
      tier: 'C',
      title: 'Casual Curator',
      description: 'Took a few extra seconds or guesses to lock in the titles.',
      averagePointsPerRound,
      winRatePercent,
      averageDurationSec,
    };
  }

  return {
    tier: 'D',
    title: 'Rusty Listener',
    description: 'Time to revisit your liked songs playlist and sharpen your ear!',
    averagePointsPerRound,
    winRatePercent,
    averageDurationSec,
  };
}
