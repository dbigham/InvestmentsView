import { describe, it, expect } from 'vitest';
import {
  getTimelineWindow,
  computePerformanceSummary,
  sliceTimeline,
  buildChartPoints,
} from './performance';

describe('getTimelineWindow', () => {
  it('returns the full range when requesting all data', () => {
    const timeline = [
      { date: '2024-01-01', value: 0, netFlows: 0 },
      { date: '2024-01-05', value: 100, netFlows: 0 },
      { date: '2024-01-10', value: 200, netFlows: 0 },
    ];

    expect(getTimelineWindow(timeline, 'all')).toEqual({ startIndex: 0, endIndex: 2 });
  });

  it('resolves a rolling window for recent periods', () => {
    const timeline = [
      { date: '2024-01-01', value: 0, netFlows: 0 },
      { date: '2024-01-05', value: 100, netFlows: 0 },
      { date: '2024-01-10', value: 200, netFlows: 0 },
      { date: '2024-01-15', value: 300, netFlows: 0 },
    ];

    expect(getTimelineWindow(timeline, '1w')).toEqual({ startIndex: 2, endIndex: 3 });
  });

  it('returns null when the timeline is empty', () => {
    expect(getTimelineWindow([], '1w')).toBeNull();
  });
});

describe('sliceTimeline', () => {
  it('returns an inclusive slice across the provided bounds', () => {
    const timeline = [
      { date: '2024-01-01', value: 0, netFlows: 0 },
      { date: '2024-01-02', value: 50, netFlows: 0 },
      { date: '2024-01-03', value: 75, netFlows: 0 },
    ];

    expect(sliceTimeline(timeline, 1, 2)).toEqual([
      { date: '2024-01-02', value: 50, netFlows: 0 },
      { date: '2024-01-03', value: 75, netFlows: 0 },
    ]);
  });

  it('returns an empty array when the bounds are invalid', () => {
    const timeline = [
      { date: '2024-01-01', value: 0, netFlows: 0 },
      { date: '2024-01-02', value: 50, netFlows: 0 },
    ];

    expect(sliceTimeline(timeline, 2, 1)).toEqual([]);
  });
});

describe('buildChartPoints', () => {
  it('normalizes the timeline data for chart rendering', () => {
    const timeline = [
      { date: '2024-01-01', value: '100.5' },
      { date: '2024-01-02', value: null },
    ];

    expect(buildChartPoints(timeline)).toEqual([
      { date: '2024-01-01', value: 100.5 },
      { date: '2024-01-02', value: 0 },
    ]);
  });

  it('returns an empty array when no data is provided', () => {
    expect(buildChartPoints(null)).toEqual([]);
  });
});

describe('computePerformanceSummary', () => {
  it('calculates totals and CAGR across the full timeline', () => {
    const timeline = [
      { date: '2024-01-01', value: 0, netFlows: 0 },
      { date: '2024-01-02', value: 1000, netFlows: 1000 },
      { date: '2025-01-02', value: 1100, netFlows: 0 },
    ];

    const summary = computePerformanceSummary(timeline, 'all');

    expect(summary).not.toBeNull();
    expect(summary.startIndex).toBe(0);
    expect(summary.endIndex).toBe(2);
    expect(summary.startValue).toBe(0);
    expect(summary.endValue).toBe(1100);
    expect(summary.netFlows).toBe(1000);
    expect(summary.totalPnl).toBe(100);
    expect(summary.percent).toBeCloseTo(10, 5);
    expect(summary.cagr).toBeCloseTo(9.9785, 4);
    expect(summary.startDate).toBe('2024-01-01');
    expect(summary.endDate).toBe('2025-01-02');
  });

  it('uses the previous value as the baseline for partial windows', () => {
    const timeline = [
      { date: '2024-01-01', value: 0, netFlows: 0 },
      { date: '2024-01-10', value: 1000, netFlows: 1000 },
      { date: '2024-12-01', value: 1200, netFlows: 0 },
      { date: '2024-12-20', value: 1250, netFlows: 0 },
      { date: '2025-01-10', value: 1350, netFlows: 0 },
    ];

    const summary = computePerformanceSummary(timeline, '1m');

    expect(summary).not.toBeNull();
    expect(summary.startIndex).toBe(3);
    expect(summary.endIndex).toBe(4);
    expect(summary.startValue).toBe(1200);
    expect(summary.endValue).toBe(1350);
    expect(summary.netFlows).toBe(0);
    expect(summary.totalPnl).toBe(150);
    expect(summary.percent).toBeCloseTo(12.5, 5);
    expect(summary.cagr).toBeGreaterThan(0);
    expect(Number.isFinite(summary.cagr)).toBe(true);
  });

  it('returns null when the timeline cannot be evaluated', () => {
    expect(computePerformanceSummary([], 'all')).toBeNull();
  });
});
