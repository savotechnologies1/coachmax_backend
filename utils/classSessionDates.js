const DAY_MAP = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

const generateDatesForDay = (start, end, targetDay) => {
  const dates = [];
  const current = new Date(start);

  while (current.getUTCDay() !== targetDay) {
    current.setUTCDate(current.getUTCDate() + 1);
  }

  while (current <= end) {
    dates.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 7);
  }

  return dates;
};

const generateClassSessions = (term, classObj) => {
  const sessions = [];
  if (Array.isArray(classObj?.sessionDates) && classObj.sessionDates.length > 0) {
    let sorted = [...classObj.sessionDates]
      .map((value) => {
        const date = new Date(value);
        date.setUTCHours(0, 0, 0, 0);
        return date;
      })
      .sort((a, b) => a.getTime() - b.getTime());

    const roundLimit = Number(classObj.round || classObj.rounds || classObj.numberOfRounds);
    if (roundLimit > 0) sorted = sorted.slice(0, roundLimit);
    return sorted;
  }
  const dateRange = term?.startDate && term?.endDate ? term : classObj;
  if (!dateRange?.startDate || !dateRange?.endDate) return sessions;

  const start = new Date(dateRange.startDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(dateRange.endDate);
  end.setUTCHours(0, 0, 0, 0);
  const scheduleType = classObj.scheduleType || "SINGLE_DAY";
  const schedule = classObj.schedule || [];

  if ((scheduleType === "WEEKDAYS" || scheduleType === "CUSTOM") && schedule.length > 0) {
    for (const entry of schedule) {
      const targetDay = DAY_MAP[(entry.dayOfWeek || "").toUpperCase()];
      if (targetDay === undefined) continue;
      sessions.push(...generateDatesForDay(start, end, targetDay));
    }
    sessions.sort((a, b) => a.getTime() - b.getTime());
  } else {
    if (!classObj.dayOfWeek) return sessions;
    const targetDay = DAY_MAP[classObj.dayOfWeek.toUpperCase()];
    if (targetDay === undefined) return sessions;
    sessions.push(...generateDatesForDay(start, end, targetDay));
  }

  const roundLimit = Number(classObj?.round || classObj?.rounds || classObj?.numberOfRounds);
  return roundLimit > 0 ? sessions.slice(0, roundLimit) : sessions;
};

module.exports = { DAY_MAP, generateDatesForDay, generateClassSessions };
