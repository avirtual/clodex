'use strict';

function archiveWarnings({ name, type, activity, attention, ticket, team, lead }) {
  if (type === 'bash') return [];
  const warnings = [];
  if (attention || (activity && activity !== 'idle')) warnings.push('is working');
  if (ticket) warnings.push(`holds ticket ${ticket}`);
  if (team && lead && lead === name) warnings.push(`is the lead of team ${team}`);
  return warnings;
}

function archiveConfirmText(row) {
  const warnings = archiveWarnings(row);
  const head = `Archive session "${row.name}"?`;
  const body = 'Its process stops; the session is archived, not deleted, and can be resumed from its sidebar row.';
  return warnings.length
    ? `${head}\n\nWarning: ${row.name} ${warnings.join(' and ')}.\n\n${body}`
    : `${head}\n\n${body}`;
}

async function guardedArchive(row, { leadOf, confirm, archive }) {
  const lead = row.team && row.type !== 'bash' ? await leadOf(row.team) : null;
  if (!confirm(archiveConfirmText({ ...row, lead }))) return false;
  await archive(row.name);
  return true;
}

module.exports = { archiveWarnings, archiveConfirmText, guardedArchive };
