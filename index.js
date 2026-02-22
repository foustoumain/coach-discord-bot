require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder
} = require('discord.js');
const { google } = require('googleapis');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const TZ = 'Europe/Paris';
const TAB_CURRENT = 'Semaine_Courante';
const TAB_NEXT = 'Semaine_Avenir';
const TAB_HISTORY = 'Historique';

const HOURS = Array.from({ length: 14 }, (_, i) => `${i + 10}h`); // 10h..23h
const DAYS = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

let planningCurrentMessage = null;
let planningNextMessage = null;
let reservationsMessage = null;

// ====== Logs erreurs ======
process.on('unhandledRejection', (err) => console.error('❌ UnhandledRejection:', err?.response?.data || err));
process.on('uncaughtException', (err) => console.error('❌ UncaughtException:', err?.response?.data || err));

// ================= GOOGLE =================

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// ================= DATE HELPERS =================

function nowParis() {
  return DateTime.now().setZone(TZ);
}
function mondayOfWeek(dt) {
  return dt.startOf('day').minus({ days: dt.weekday - 1 }); // 1=lundi
}
function weekMondayISO(offsetWeeks = 0) {
  return mondayOfWeek(nowParis()).plus({ weeks: offsetWeeks }).toISODate();
}
function ddmmFromISO(isoDate) {
  return DateTime.fromISO(isoDate, { zone: TZ }).toFormat('dd/LL');
}
function addDaysISO(isoDate, days) {
  return DateTime.fromISO(isoDate, { zone: TZ }).plus({ days }).toISODate();
}
function slotDateTimeParis(slotISO, hourStr) {
  const hour = parseInt(String(hourStr).match(/(\d{1,2})/)?.[1] || '0', 10);
  return DateTime.fromISO(slotISO, { zone: TZ }).set({ hour, minute: 0, second: 0, millisecond: 0 });
}
function weekRangeText(mondayISO) {
  const monday = DateTime.fromISO(mondayISO, { zone: TZ });
  const sunday = monday.plus({ days: 6 });
  return `${monday.toFormat('dd/LL')} → ${sunday.toFormat('dd/LL')}`;
}
function a1ColLetter(colIdx0) {
  return String.fromCharCode(65 + colIdx0);
}
function hourToNumber(h) {
  const m = String(h || '').match(/(\d{1,2})/);
  return m ? Number(m[1]) : 0;
}

// ================= SHEETS HELPERS =================

async function getSpreadsheetMeta() {
  return sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
}

async function ensureSheetExists(title) {
  const meta = await getSpreadsheetMeta();
  const exists = meta.data.sheets?.some(s => s.properties?.title === title);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] }
  });
}

async function getSheetIdByTitle(title) {
  const meta = await getSpreadsheetMeta();
  const sheet = meta.data.sheets?.find(s => s.properties?.title === title);
  return sheet?.properties?.sheetId ?? null;
}

async function clearRange(rangeA1) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: rangeA1,
  });
}

async function writeRange(rangeA1, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: rangeA1,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

async function getTabData(tabName) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${tabName}!A1:H200`,
  });
  return resp.data.values || [];
}

function findDayColumnIndex(displayHeaderRow, dayName) {
  for (let col = 1; col <= 7; col++) {
    const v = (displayHeaderRow[col] || '').trim();
    if (v.startsWith(dayName)) return col;
  }
  return -1;
}

// dispo = checkbox cochée (TRUE) OU "Oui"
function isAvailableCell(v) {
  const t = (v ?? '').toString().trim().toLowerCase();
  return t === 'true' || t === 'oui';
}

async function setReservation(tabName, rowNumber1Based, colNumber1Based) {
  const cell = `${tabName}!${a1ColLetter(colNumber1Based - 1)}${rowNumber1Based}`;
  await writeRange(cell, [['Réservé']]);
}

async function appendHistoryRow({ slotISO, ddmm, dayName, hour, user }) {
  await ensureSheetExists(TAB_HISTORY);
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${TAB_HISTORY}!A:F`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ddmm, hour, dayName, user, new Date().toISOString(), slotISO]] },
  });
}

async function getHistoryRows() {
  await ensureSheetExists(TAB_HISTORY);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${TAB_HISTORY}!A:F`,
  });
  const values = resp.data.values || [];
  return values.filter(r => (r[0] || '').trim() !== 'Date');
}

// ================= CHECKBOXES B3:H16 =================

async function applyCheckboxes(tabName) {
  const sheetId = await getSheetIdByTitle(tabName);
  if (sheetId === null) throw new Error(`SheetId introuvable pour ${tabName}`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    requestBody: {
      requests: [{
        setDataValidation: {
          range: {
            sheetId,
            startRowIndex: 2,     // row 3
            endRowIndex: 16,      // row 16 end exclusive => couvre 3..16
            startColumnIndex: 1,  // col B
            endColumnIndex: 8,    // col H end exclusive
          },
          rule: {
            condition: { type: 'BOOLEAN' },
            showCustomUi: true,
            strict: true,
          }
        }
      }]
    }
  });
}

// ================= CALENDAR GENERATION =================

function buildWeekTable(mondayISO) {
  const headerDisplay = ['Heures', ...DAYS.map((d, i) => `${d} ${ddmmFromISO(addDaysISO(mondayISO, i))}`)];
  const headerISO = ['ISO', ...DAYS.map((_, i) => addDaysISO(mondayISO, i))];

  // ✅ cases cochables mais NON cochées par défaut
  const rows = HOURS.map(h => [h, ...Array(7).fill(false)]);

  return [headerDisplay, headerISO, ...rows];
}

async function generateWeekTab(tabName, mondayISO) {
  await ensureSheetExists(tabName);
  await clearRange(`${tabName}!A1:H200`);
  const table = buildWeekTable(mondayISO);
  await writeRange(`${tabName}!A1:H${table.length}`, table);
  await applyCheckboxes(tabName);
}

async function ensureCalendarTabsUpToDate() {
  await ensureSheetExists(TAB_HISTORY);
  await generateWeekTab(TAB_CURRENT, weekMondayISO(0));
  await generateWeekTab(TAB_NEXT, weekMondayISO(1));
}

// ================= EMBEDS =================

function computeAvailableDays(tabData, isCurrentWeek) {
  const now = nowParis();
  if (!tabData || tabData.length < 3) {
    return { availableDayNames: [] };
  }

  const displayHeader = tabData[0];
  const isoHeader = tabData[1];
  const map = new Map(); // dayName -> hasAny

  for (let col = 1; col <= 7; col++) {
    const header = (displayHeader[col] || '').trim();
    if (!header) continue;

    const dayName = header.split(' ')[0];
    const dayISO = (isoHeader[col] || '').trim();

    // semaine en cours: jour entièrement passé => pas de bouton
    if (isCurrentWeek) {
      const dayEnd = DateTime.fromISO(dayISO, { zone: TZ }).endOf('day');
      if (dayEnd < now) {
        map.set(dayName, false);
        continue;
      }
    }

    let hasAny = false;
    for (let r = 2; r < tabData.length; r++) {
      const hour = (tabData[r]?.[0] || '').trim();
      const cell = tabData[r]?.[col];
      if (!hour) continue;
      if (!isAvailableCell(cell)) continue;

      if (isCurrentWeek) {
        const slotDT = slotDateTimeParis(dayISO, hour);
        if (slotDT < now) continue;
      }

      hasAny = true;
      break;
    }

    map.set(dayName, hasAny);
  }

  const availableDayNames = DAYS.filter(d => map.get(d));
  return { availableDayNames };
}

function buildPlanningText(tabData, isCurrentWeek) {
  if (!tabData.length) return `Aucune donnée.`;

  const now = nowParis();
  const displayHeader = tabData[0];
  const isoHeader = tabData[1];

  let out = '';

  for (let col = 1; col <= 7; col++) {
    const header = (displayHeader[col] || '').trim();
    if (!header) continue;

    const dayName = header.split(' ')[0];
    const dayISO = (isoHeader[col] || '').trim();

    // semaine en cours: cacher les jours déjà passés
    if (isCurrentWeek) {
      const dayEnd = DateTime.fromISO(dayISO, { zone: TZ }).endOf('day');
      if (dayEnd < now) continue;
    }

    const hours = [];
    for (let r = 2; r < tabData.length; r++) {
      const hour = (tabData[r]?.[0] || '').trim();
      const cell = tabData[r]?.[col];

      if (!hour) continue;
      if (!isAvailableCell(cell)) continue;

      // semaine en cours: cacher les heures déjà passées
      if (isCurrentWeek) {
        const slotDT = slotDateTimeParis(dayISO, hour);
        if (slotDT < now) continue;
      }

      hours.push(`\`${hour}\``);
    }

    if (!hours.length) {
      out += `🔴 **${dayName}**\n`;
      out += `Aucun créneau\n\u200B\n`;
    } else {
      out += `🟢 **${dayName}**\n`;
      out += `${hours.join(' • ')}\n\u200B\n`;
    }
  }

  return out.trim() || `Aucun jour affichable (tout est passé).`;
}

async function buildPlanningCurrentEmbed() {
  const curMonday = weekMondayISO(0);
  const curData = await getTabData(TAB_CURRENT);

  return new EmbedBuilder()
    .setTitle('🗓️ Planning — Semaine en cours')
    .setDescription(`🔵 **${weekRangeText(curMonday)}**\n\u200B\n*Choisis un jour puis une heure.*`)
    .setColor(0x3498db)
    .addFields({ name: '📅 Disponibilités', value: buildPlanningText(curData, true), inline: false })
    .setTimestamp();
}

async function buildPlanningNextEmbed() {
  const nxtMonday = weekMondayISO(1);
  const nxtData = await getTabData(TAB_NEXT);

  return new EmbedBuilder()
    .setTitle('🗓️ Planning — Semaine à venir')
    .setDescription(`🟣 **${weekRangeText(nxtMonday)}**\n\u200B\n*Choisis un jour puis une heure.*`)
    .setColor(0x9b59b6)
    .addFields({ name: '📅 Disponibilités', value: buildPlanningText(nxtData, false), inline: false })
    .setTimestamp();
}

function clampList(lines, max = 30) {
  if (lines.length <= max) return { text: lines.join('\n'), extra: 0 };
  return { text: lines.slice(0, max).join('\n'), extra: lines.length - max };
}

async function buildReservationsEmbed() {
  const history = await getHistoryRows();
  const items = [];

  for (const r of history) {
    const ddmm = (r[0] || '').trim();
    const hour = (r[1] || '').trim();
    const day = (r[2] || '').trim();
    const user = (r[3] || '').trim();
    const slotISO = (r[5] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slotISO)) continue;

    items.push({
      slotISO,
      hourNum: hourToNumber(hour),
      line: `• **${day} ${ddmm}** — \`${hour}\` → **${user}**`
    });
  }

  items.sort((a, b) => a.slotISO.localeCompare(b.slotISO) || (a.hourNum - b.hourNum));

  const clamped = clampList(items.map(x => x.line), 30);

  return new EmbedBuilder()
    .setTitle('📌 Réservations')
    .setColor(0x2ecc71)
    .setDescription((clamped.text || 'Aucune réservation.') + (clamped.extra ? `\n… +${clamped.extra} autres` : ''))
    .setTimestamp()
    .setFooter({ text: '📜 Historique global via le bouton.' });
}

// ================= BUTTONS =================

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function buildComponentsForCurrentPlanning(availableDayNames) {
  const mk = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const rows = [];
  const curButtons = availableDayNames.map(d => mk(`cur_${d}`, d, ButtonStyle.Primary));
  for (const g of chunk(curButtons, 5)) rows.push(new ActionRowBuilder().addComponents(...g));
  return rows;
}

function buildComponentsForNextPlanning(availableDayNames) {
  const mk = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const rows = [];
  const nxtButtons = availableDayNames.map(d => mk(`nxt_${d}`, d, ButtonStyle.Success));
  for (const g of chunk(nxtButtons, 5)) rows.push(new ActionRowBuilder().addComponents(...g));
  return rows;
}

function buildHistoryRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('historique').setLabel('📜 Historique').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('refresh_manual').setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
  );
}

// ================= DISCORD CLEANUP =================

async function findLatestBotMessageByEmbedTitle(channel, title) {
  const msgs = await channel.messages.fetch({ limit: 50 });
  const botId = client.user.id;

  const candidates = [...msgs.values()]
    .filter(m => m.author?.id === botId && m.embeds?.[0]?.title === title)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  return candidates[0] || null;
}

async function deleteDuplicateBotMessagesByEmbedTitle(channel, title, keepMessageId) {
  const msgs = await channel.messages.fetch({ limit: 50 });
  const botId = client.user.id;

  const dupes = [...msgs.values()]
    .filter(m => m.author?.id === botId && m.embeds?.[0]?.title === title && m.id !== keepMessageId);

  for (const m of dupes) {
    try { await m.delete(); } catch {}
  }
}

async function ensurePlanningOrderAndDedupe(channel) {
  const titleCur = '🗓️ Planning — Semaine en cours';
  const titleNxt = '🗓️ Planning — Semaine à venir';
  const titleRes = '📌 Réservations';

  const curMsg = await findLatestBotMessageByEmbedTitle(channel, titleCur);
  const nxtMsg = await findLatestBotMessageByEmbedTitle(channel, titleNxt);
  const resMsg = await findLatestBotMessageByEmbedTitle(channel, titleRes);

  if (curMsg) await deleteDuplicateBotMessagesByEmbedTitle(channel, titleCur, curMsg.id);
  if (nxtMsg) await deleteDuplicateBotMessagesByEmbedTitle(channel, titleNxt, nxtMsg.id);
  if (resMsg) await deleteDuplicateBotMessagesByEmbedTitle(channel, titleRes, resMsg.id);

  planningCurrentMessage = curMsg;
  planningNextMessage = nxtMsg;
  reservationsMessage = resMsg;

  if (planningCurrentMessage && planningNextMessage) {
    if (planningCurrentMessage.createdTimestamp > planningNextMessage.createdTimestamp) {
      try { await planningCurrentMessage.delete(); } catch {}
      try { await planningNextMessage.delete(); } catch {}
      planningCurrentMessage = null;
      planningNextMessage = null;
    }
  }
}

// ================= SAFE EDIT/SEND HELPERS =================

function isUnknownMessageError(err) {
  const code = err?.code || err?.rawError?.code;
  return code === 10008;
}

async function safeEditOrSend(currentMsg, channel, payload) {
  if (currentMsg) {
    try {
      await currentMsg.edit(payload);
      return currentMsg;
    } catch (err) {
      if (isUnknownMessageError(err)) {
        return await channel.send(payload);
      }
      throw err;
    }
  }
  return await channel.send(payload);
}

// ================= REFRESH =================

async function refreshAll() {
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);

  // on lit les datas une fois
  const curData = await getTabData(TAB_CURRENT);
  const nxtData = await getTabData(TAB_NEXT);

  // jours avec au moins 1 créneau affichable => boutons
  const curInfo = computeAvailableDays(curData, true);
  const nxtInfo = computeAvailableDays(nxtData, false);

  const planningCurEmbed = await buildPlanningCurrentEmbed();
  const planningNxtEmbed = await buildPlanningNextEmbed();
  const reservationsEmbed = await buildReservationsEmbed();

  const curComponents = [...buildComponentsForCurrentPlanning(curInfo.availableDayNames), buildHistoryRow()].slice(0, 5);
  const nxtComponents = [...buildComponentsForNextPlanning(nxtInfo.availableDayNames), buildHistoryRow()].slice(0, 5);

  planningCurrentMessage = await safeEditOrSend(
    planningCurrentMessage,
    channel,
    { embeds: [planningCurEmbed], components: curComponents }
  );

  planningNextMessage = await safeEditOrSend(
    planningNextMessage,
    channel,
    { embeds: [planningNxtEmbed], components: nxtComponents }
  );

  reservationsMessage = await safeEditOrSend(
    reservationsMessage,
    channel,
    { embeds: [reservationsEmbed] }
  );
}

// ================= INTERACTIONS =================

function isAdminOrManager(interaction) {
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return perms.has('Administrator') || perms.has('ManageGuild');
}

client.on('interactionCreate', async (interaction) => {
  // 📜 Historique
  if (interaction.isButton() && interaction.customId === 'historique') {
    const history = await getHistoryRows();
    const last = history.slice(-30);

    const embed = new EmbedBuilder()
      .setTitle('📜 Historique global')
      .setColor(0x95a5a6)
      .setDescription(
        last.length
          ? last.map(r => `• ${r[2]} ${r[0]} à ${r[1]} → **${r[3]}**`).join('\n')
          : 'Aucune réservation.'
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // 🔄 Refresh manuel
  if (interaction.isButton() && interaction.customId === 'refresh_manual') {
    if (!isAdminOrManager(interaction)) {
      return interaction.reply({ content: "⛔ Tu n'as pas la permission d'utiliser ce bouton.", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    await refreshAll();
    await interaction.editReply("✅ Refresh effectué.");

    setTimeout(async () => {
      try { await interaction.deleteReply(); } catch {}
    }, 2500);
    return;
  }

  // Choix jour
  if (interaction.isButton() && (interaction.customId.startsWith('cur_') || interaction.customId.startsWith('nxt_'))) {
    const [weekKey, dayName] = interaction.customId.split('_');
    const tabName = weekKey === 'cur' ? TAB_CURRENT : TAB_NEXT;

    const tabData = await getTabData(tabName);
    if (tabData.length < 3) return interaction.reply({ content: "❌ Calendrier pas prêt.", ephemeral: true });

    const displayHeader = tabData[0];
    const isoHeader = tabData[1];
    const dayCol = findDayColumnIndex(displayHeader, dayName);
    if (dayCol === -1) return interaction.reply({ content: "❌ Jour introuvable.", ephemeral: true });

    const dayISO = (isoHeader[dayCol] || '').trim();
    const now = nowParis();

    const options = [];
    for (let r = 2; r < tabData.length; r++) {
      const hour = (tabData[r]?.[0] || '').trim();
      const cell = tabData[r]?.[dayCol];

      if (!hour) continue;
      if (!isAvailableCell(cell)) continue;

      if (weekKey === 'cur') {
        const slotDT = slotDateTimeParis(dayISO, hour);
        if (slotDT < now) continue;
      }

      const sheetRow = r + 1;
      const sheetCol = dayCol + 1;

      options.push({
        label: hour,
        value: `${tabName}|${sheetRow}|${sheetCol}|${dayName}|${dayISO}|${hour}`,
      });
    }

    if (!options.length) return interaction.reply({ content: "🔒 Aucun créneau réservable.", ephemeral: true });

    const select = new StringSelectMenuBuilder()
      .setCustomId('pick_slot')
      .setPlaceholder(`Choisis une heure (${dayName})`)
      .addOptions(options.slice(0, 25));

    const row = new ActionRowBuilder().addComponents(select);

    return interaction.reply({
      content: `🕒 **${dayName}** — choisis une heure (${weekKey === 'cur' ? 'semaine en cours' : 'semaine à venir'})`,
      components: [row],
      ephemeral: true
    });
  }

  // Réservation (silencieuse)
  if (interaction.isStringSelectMenu() && interaction.customId === 'pick_slot') {
    await interaction.deferUpdate();

    const [tabName, sheetRowStr, sheetColStr, dayName, dayISO, hour] = interaction.values[0].split('|');
    const sheetRow = Number(sheetRowStr);
    const sheetCol = Number(sheetColStr);

    const tabData = await getTabData(tabName);
    const rIdx = sheetRow - 1;
    const cIdx = sheetCol - 1;

    const current = (tabData?.[rIdx]?.[cIdx] || '').toString().trim().toLowerCase();
    if (!(current === 'true' || current === 'oui')) {
      try { await interaction.editReply({ content: "⚠️ Ce créneau n'est plus disponible.", components: [] }); } catch {}
      return;
    }

    if (tabName === TAB_CURRENT) {
      const now = nowParis();
      const slotDT = slotDateTimeParis(dayISO, hour);
      if (slotDT < now) {
        try { await interaction.editReply({ content: "⚠️ Ce créneau est déjà passé.", components: [] }); } catch {}
        return;
      }
    }

    await setReservation(tabName, sheetRow, sheetCol);

    await appendHistoryRow({
      slotISO: dayISO,
      ddmm: ddmmFromISO(dayISO),
      dayName,
      hour,
      user: interaction.user.username
    });

    await refreshAll();

    try {
      await interaction.editReply({ content: "✅ Créneau réservé.", components: [] });
      setTimeout(async () => {
        try { await interaction.deleteReply(); } catch {}
      }, 2500);
    } catch {}
  }
});

// ================= CRON =================

cron.schedule('0 23 * * 0', async () => {
  await ensureCalendarTabsUpToDate();
  await refreshAll();
}, { timezone: TZ });

cron.schedule('0 * * * *', async () => {
  console.log('🔄 Refresh automatique (horaire)');
  await refreshAll();
}, { timezone: TZ });

// ================= READY =================

async function onReady() {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);

  await ensureCalendarTabsUpToDate();
  await ensurePlanningOrderAndDedupe(channel);
  await refreshAll();
}

client.once('ready', onReady);
client.login(process.env.DISCORD_TOKEN);