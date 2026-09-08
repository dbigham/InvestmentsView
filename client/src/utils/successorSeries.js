export function stitchConcreteSuccessorSeries(destinationSeries, historicalSeriesList, historyStartDate) {
  if (
    !destinationSeries ||
    !Array.isArray(destinationSeries.points) ||
    !destinationSeries.points.length ||
    !Array.isArray(historicalSeriesList) ||
    !historicalSeriesList.length
  ) {
    return null;
  }

  const boundary =
    typeof historyStartDate === 'string' && historyStartDate.trim()
      ? historyStartDate.trim().slice(0, 10)
      : destinationSeries.points[0]?.date || null;
  if (!boundary) {
    return null;
  }

  const historicalByDate = new Map();
  let pnlCarryForward = 0;
  let historicalEquityTotal = 0;
  let historicalDepositsTotal = 0;
  let hasHistoricalBoundaryPoint = false;
  let hasCompleteHistoricalBoundaryBasis = true;

  const resolveTransferOutBasis = (points) => {
    const usablePoints = points
      .filter(
        (point) =>
          point &&
          typeof point.date === 'string' &&
          point.date <= boundary &&
          Number.isFinite(Number(point.equityCad))
      )
      .sort((a, b) => a.date.localeCompare(b.date));
    for (let index = 1; index < usablePoints.length; index += 1) {
      const priorPoint = usablePoints[index - 1];
      const currentPoint = usablePoints[index];
      const priorEquity = Number(priorPoint.equityCad);
      const currentEquity = Number(currentPoint.equityCad);
      const collapseThreshold = Math.max(100, Math.abs(priorEquity) * 0.25);
      const looksLikeCollapse =
        priorEquity > 100 &&
        currentEquity <= priorEquity * 0.5 &&
        priorEquity - currentEquity >= collapseThreshold;
      if (!looksLikeCollapse) {
        continue;
      }
      const recovered = usablePoints.slice(index + 1).some((point) => Number(point.equityCad) >= priorEquity * 0.8);
      if (!recovered) {
        return {
          basisPoint: priorPoint,
          pointsForDisplay: usablePoints.filter((point) => point.date <= priorPoint.date),
        };
      }
    }
    return { basisPoint: usablePoints[usablePoints.length - 1], pointsForDisplay: usablePoints };
  };

  historicalSeriesList.forEach((series) => {
    if (!series || !Array.isArray(series.points)) {
      return;
    }
    const points = series.points.filter((point) => point && point.date <= boundary);
    if (!points.length) {
      return;
    }
    hasHistoricalBoundaryPoint = true;
    const historicalBasis = resolveTransferOutBasis(points);
    const lastHistoricalPoint = historicalBasis.basisPoint;
    const pointsForDisplay = historicalBasis.pointsForDisplay;
    const hasMeaningfulHistoricalPoint = pointsForDisplay.some((point) =>
      ['equityCad', 'cumulativeNetDepositsCad', 'totalPnlCad', 'cadCash', 'usdCash', 'cadSecurityValue', 'usdSecurityValue']
        .some((field) => {
          const value = Number(point[field]);
          return Number.isFinite(value) && Math.abs(value) >= 1e-6;
        })
    );
    if (!lastHistoricalPoint || !pointsForDisplay.length || !hasMeaningfulHistoricalPoint) {
      return;
    }
    const historicalPnl = Number(lastHistoricalPoint.totalPnlCad);
    if (Number.isFinite(historicalPnl)) {
      pnlCarryForward += historicalPnl;
    }
    const historicalEquity = Number(lastHistoricalPoint.equityCad);
    const historicalDeposits = Number(lastHistoricalPoint.cumulativeNetDepositsCad);
    if (Number.isFinite(historicalEquity) && Number.isFinite(historicalDeposits)) {
      historicalEquityTotal += historicalEquity;
      historicalDepositsTotal += historicalDeposits;
    } else {
      hasCompleteHistoricalBoundaryBasis = false;
    }

    pointsForDisplay
      .filter((point) => point.date < boundary)
      .forEach((point) => {
        const existing = historicalByDate.get(point.date) || { date: point.date };
        ['equityCad', 'cumulativeNetDepositsCad', 'totalPnlCad', 'cadCash', 'usdCash', 'cadSecurityValue', 'usdSecurityValue']
          .forEach((field) => {
            const value = Number(point[field]);
            if (Number.isFinite(value)) {
              existing[field] = (Number.isFinite(existing[field]) ? existing[field] : 0) + value;
            }
          });
        historicalByDate.set(point.date, existing);
      });
  });

  if (!hasHistoricalBoundaryPoint || !Number.isFinite(pnlCarryForward)) {
    return null;
  }

  const destinationBoundaryPoint = destinationSeries.points.find(
    (point) => point && typeof point.date === 'string' && point.date >= boundary
  );
  const destinationEquity = Number(destinationBoundaryPoint?.equityCad);
  const destinationDeposits = Number(destinationBoundaryPoint?.cumulativeNetDepositsCad);
  const boundaryEquityTolerance = Math.max(
    1,
    Math.max(Math.abs(historicalEquityTotal), Math.abs(destinationEquity)) * 0.005
  );
  const hasMatchingBoundaryEquity =
    hasCompleteHistoricalBoundaryBasis &&
    Number.isFinite(destinationEquity) &&
    Number.isFinite(destinationDeposits) &&
    Math.abs(historicalEquityTotal - destinationEquity) <= boundaryEquityTolerance;
  const depositCarryForward = hasMatchingBoundaryEquity
    ? historicalDepositsTotal - destinationDeposits
    : 0;
  const canRebaseToHistoricalBoundary =
    hasCompleteHistoricalBoundaryBasis &&
    Number.isFinite(historicalEquityTotal) &&
    Number.isFinite(historicalDepositsTotal) &&
    Number.isFinite(destinationEquity) &&
    Number.isFinite(destinationDeposits);
  const hasPnlAdjustment = Math.abs(pnlCarryForward) >= 1e-6;
  const hasDepositAdjustment =
    hasMatchingBoundaryEquity && Math.abs(historicalDepositsTotal - destinationDeposits) >= 1e-6;
  if (!historicalByDate.size && !hasPnlAdjustment && !hasDepositAdjustment) {
    return null;
  }

  const adjustedDestinationPoints = destinationSeries.points
    .filter((point) => point && point.date >= boundary)
    .map((point) => {
      const adjusted = { ...point };
      if (Number.isFinite(Number(adjusted.totalPnlCad))) {
        adjusted.totalPnlCad = Number(adjusted.totalPnlCad) + pnlCarryForward;
      }
      if (hasMatchingBoundaryEquity && Number.isFinite(Number(adjusted.cumulativeNetDepositsCad))) {
        adjusted.cumulativeNetDepositsCad = Number(adjusted.cumulativeNetDepositsCad) + depositCarryForward;
      }
      if (canRebaseToHistoricalBoundary) {
        const relativeDeposits = Number(point.cumulativeNetDepositsCad) - destinationDeposits;
        // Match server stitching: carry historical return through inferred
        // capital, preserving the successor's actual observed equity.
        const rebasedEquity = Number(adjusted.equityCad);
        const migrationCapitalAdjustmentCad = destinationEquity - historicalEquityTotal;
        const rebasedDeposits = historicalDepositsTotal + relativeDeposits + migrationCapitalAdjustmentCad;
        if (Number.isFinite(rebasedEquity) && Number.isFinite(rebasedDeposits)) {
          adjusted.equityCad = rebasedEquity;
          adjusted.cumulativeNetDepositsCad = rebasedDeposits;
          const rebasedPnl = rebasedEquity - rebasedDeposits;
          adjusted.totalPnlCad = Math.abs(rebasedPnl) < 1e-6 ? 0 : rebasedPnl;
        }
      }
      // Recompute display-relative deltas from the stitched absolute values;
      // the destination's cached deltas use its successor-only baseline.
      delete adjusted.totalPnlSinceDisplayStartCad;
      delete adjusted.equitySinceDisplayStartCad;
      delete adjusted.cumulativeNetDepositsSinceDisplayStartCad;
      return adjusted;
    });

  const adjustedSummary =
    destinationSeries.summary && typeof destinationSeries.summary === 'object'
      ? { ...destinationSeries.summary }
      : {};
  if (Number.isFinite(Number(adjustedSummary.totalPnlCad))) {
    adjustedSummary.totalPnlCad = Number(adjustedSummary.totalPnlCad) + pnlCarryForward;
    adjustedSummary.totalPnlAllTimeCad = adjustedSummary.totalPnlCad;
  }
  if (hasMatchingBoundaryEquity && Number.isFinite(Number(adjustedSummary.netDepositsCad))) {
    adjustedSummary.netDepositsCad = Number(adjustedSummary.netDepositsCad) + depositCarryForward;
    adjustedSummary.netDepositsAllTimeCad = adjustedSummary.netDepositsCad;
  }

  const historicalPoints = Array.from(historicalByDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  const points = [...historicalPoints, ...adjustedDestinationPoints].sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) {
    return null;
  }

  if (canRebaseToHistoricalBoundary && adjustedDestinationPoints.length) {
    const lastAdjustedPoint = adjustedDestinationPoints[adjustedDestinationPoints.length - 1];
    if (Number.isFinite(lastAdjustedPoint?.totalPnlCad)) {
      adjustedSummary.totalPnlCad = lastAdjustedPoint.totalPnlCad;
      adjustedSummary.totalPnlAllTimeCad = lastAdjustedPoint.totalPnlCad;
    }
    if (Number.isFinite(lastAdjustedPoint?.cumulativeNetDepositsCad)) {
      adjustedSummary.netDepositsCad = lastAdjustedPoint.cumulativeNetDepositsCad;
      adjustedSummary.netDepositsAllTimeCad = lastAdjustedPoint.cumulativeNetDepositsCad;
    }
  }

  const displayStartPoint = historicalPoints[0] || points[0];
  const finalPoint = points[points.length - 1] || null;
  const displayStartTotals = displayStartPoint
    ? {
        totalPnlCad: Number.isFinite(Number(displayStartPoint.totalPnlCad))
          ? Number(displayStartPoint.totalPnlCad)
          : null,
        equityCad: Number.isFinite(Number(displayStartPoint.equityCad))
          ? Number(displayStartPoint.equityCad)
          : null,
        cumulativeNetDepositsCad: Number.isFinite(Number(displayStartPoint.cumulativeNetDepositsCad))
          ? Number(displayStartPoint.cumulativeNetDepositsCad)
          : null,
      }
    : destinationSeries.summary?.displayStartTotals;
  if (displayStartTotals && finalPoint) {
    const finalPnlCad = Number(finalPoint.totalPnlCad);
    const finalEquityCad = Number(finalPoint.equityCad);
    const finalDepositsCad = Number(finalPoint.cumulativeNetDepositsCad);
    if (Number.isFinite(displayStartTotals.totalPnlCad) && Number.isFinite(finalPnlCad)) {
      adjustedSummary.totalPnlSinceDisplayStartCad = finalPnlCad - displayStartTotals.totalPnlCad;
    }
    if (Number.isFinite(displayStartTotals.equityCad) && Number.isFinite(finalEquityCad)) {
      adjustedSummary.totalEquitySinceDisplayStartCad = finalEquityCad - displayStartTotals.equityCad;
    }
    if (Number.isFinite(displayStartTotals.cumulativeNetDepositsCad) && Number.isFinite(finalDepositsCad)) {
      adjustedSummary.netDepositsSinceDisplayStartCad =
        finalDepositsCad - displayStartTotals.cumulativeNetDepositsCad;
    }
  }

  return {
    ...destinationSeries,
    periodStartDate: historicalPoints[0]?.date || destinationSeries.periodStartDate || boundary,
    displayStartDate: displayStartPoint?.date || destinationSeries.displayStartDate || boundary,
    periodEndDate: points[points.length - 1]?.date || destinationSeries.periodEndDate,
    historyStartDate: historicalPoints[0]?.date || destinationSeries.periodStartDate || boundary,
    historyStartDateEstimated: true,
    stitchedFromHistorical: true,
    points,
    summary: {
      ...adjustedSummary,
      displayStartTotals,
    },
  };
}
