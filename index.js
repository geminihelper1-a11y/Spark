const { 
  Client, 
  GatewayIntentBits, 
  ChannelType, 
  PermissionFlagsBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  Events 
} = require('discord.js');
const fs = require('fs');
const mcs = require('minecraft-server-util');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ]
});

const DATA_FILE = './data.json';
const tempVCs = new Set();
const userSelectedChannels = new Map();

// Nethrion SMP — fixed server details for the owner-only live panel (`sp smp-panel`).
const NETHRION_JAVA_HOST = 'nethrionsmp.pixelforge.gg';
const NETHRION_JAVA_PORT = 25565;
const NETHRION_BEDROCK_HOST = '15.235.165.81';
const NETHRION_BEDROCK_PORT = 26091;

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initData = { 
      mcPanel: { channelId: null, messageId: null }, 
      ytConfig: { channelId: null, ytChannelId: null, lastVideoId: null }, 
      streaks: {} 
    };
    saveData(initData);
    return initData;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed.ytConfig) parsed.ytConfig = { channelId: null, ytChannelId: null, lastVideoId: null };
    if (!parsed.mcPanel) parsed.mcPanel = { channelId: null, messageId: null };
    return parsed;
  } catch (e) {
    return { mcPanel: { channelId: null, messageId: null }, ytConfig: {}, streaks: {} };
  }
}


function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

function getYesterdayString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function cleanMotd(text) {
  if (!text) return '';
  if (typeof text !== 'string') text = String(text);
  return text.replace(/§[0-9a-fk-or]/gi, '').trim();
}

const DEFAULT_BEDROCK_PORT = 19132;

// Simple Java-only status check, used by the public `sp smp` command (works for any
// server, including ones we have no Bedrock/extra data for). Retries once before
// declaring offline, so a single dropped packet doesn't produce a false "offline".
async function fetchJavaStatus(host, port) {
  let result = null;
  let online = false;

  for (let attempt = 0; attempt < 2 && !online; attempt++) {
    try {
      result = await mcs.status(host, port, { timeout: 7000, enableSRV: true });
      online = true;
    } catch (err) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 1200));
    }
  }

  if (!online || !result) {
    return { isOnline: false, playersOnline: '0/0', version: 'N/A', motd: 'Server is Offline or Starting...' };
  }

  const playersOnline = (result.players && result.players.online !== undefined)
    ? `${result.players.online}/${result.players.max}` : '0/0';

  const rawVersion = result.version && result.version.name ? result.version.name : '';
  let version = cleanMotd(rawVersion) || '1.20+';
  if (!version || version.toLowerCase().includes('online') || version.length > 25) version = '1.20+';

  let rawMotd = '';
  if (result.motd) rawMotd = result.motd.clean || result.motd.raw || '';
  const motd = cleanMotd(rawMotd) || 'A Minecraft Server';

  return { isOnline: true, playersOnline, version, motd };
}

// Classic minimal embed for `sp smp` — same style everyone is used to.
function buildSimpleMCEmbed(ip, data) {
  const embed = new EmbedBuilder().setTimestamp();

  if (data.isOnline) {
    embed
      .setTitle('🟢 MINECRAFT SERVER STATUS: ONLINE')
      .setColor('#2ecc71')
      .addFields(
        { name: '🌐 Server IP', value: `\`${ip}\``, inline: true },
        { name: '👥 Players Online', value: `\`${data.playersOnline}\``, inline: true },
        { name: '📌 Version', value: `\`${data.version}\``, inline: true },
        { name: '📝 Description', value: `\`\`\`${data.motd}\`\`\`` }
      );
  } else {
    embed
      .setTitle('🔴 MINECRAFT SERVER STATUS: OFFLINE')
      .setColor('#e74c3c')
      .addFields(
        { name: '🌐 Server IP', value: `\`${ip}\``, inline: true },
        { name: '⚠️ Status', value: 'Server is currently offline or restarting.', inline: false }
      );
  }

  return embed;
}

// Full Java + Bedrock status (separate hosts supported), used only by the
// owner-only live panel (`sp smp-panel`) since that's the only server we
// have complete Java+Bedrock details for. Bedrock ping is retried too —
// Bedrock's RakNet ping is UDP-based and drops packets more often than TCP,
// so a single failed attempt should not be treated as "no Bedrock support".
// The Server List Ping "sample" field is only a partial, best-effort preview of
// online players — some server softwares/plugins leave it empty even when
// players are online. If that happens, fall back to the Query protocol, which
// returns the real, complete player list — but it only works if the server
// owner has enabled it (enable-query=true in server.properties).
async function fetchPlayerListViaQuery(host, port) {
  try {
    const q = await mcs.queryFull(host, port, { timeout: 5000, enableSRV: false });
    if (q && Array.isArray(q.players)) {
      return q.players.map(p => cleanMotd(p)).filter(Boolean);
    }
  } catch (err) {
    // Query protocol is disabled or unreachable — not fatal, just no name list.
  }
  return [];
}

async function fetchFullStatus(javaHost, javaPort, bedrockHost, bedrockPort) {
  let javaResult = null;
  let javaOnline = false;

  for (let attempt = 0; attempt < 2 && !javaOnline; attempt++) {
    try {
      javaResult = await mcs.status(javaHost, javaPort, { timeout: 7000, enableSRV: true });
      javaOnline = true;
    } catch (err) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 1200));
    }
  }

  let bedrockResult = null;
  let bedrockOnline = false;
  let bedrockError = null;

  for (let attempt = 0; attempt < 2 && !bedrockOnline; attempt++) {
    try {
      bedrockResult = await mcs.statusBedrock(bedrockHost, bedrockPort, { timeout: 6000, enableSRV: false });
      bedrockOnline = true;
    } catch (err) {
      bedrockError = err && err.message ? err.message : String(err);
      if (attempt === 0) await new Promise(r => setTimeout(r, 1200));
    }
  }

  if (bedrockError) {
    console.error('[Bedrock Ping Error]:', bedrockError);
  }

  const javaIp = javaPort === 25565 ? javaHost : `${javaHost}:${javaPort}`;
  const bedrockIp = `${bedrockHost}:${bedrockPort}`;

  if (!javaOnline && !bedrockOnline) {
    return {
      isOnline: false,
      playersOnline: '0/0',
      version: 'N/A',
      motd: 'Server is Offline or Starting...',
      playerList: [],
      javaIp,
      bedrockIp,
      bedrockOnline: false
    };
  }

  let playersOnline = '0/0';
  let version = '1.20+';
  let motd = 'Nethrion SMP Server';
  let playerList = [];

  if (javaOnline && javaResult) {
    if (javaResult.players && javaResult.players.online !== undefined) {
      playersOnline = `${javaResult.players.online}/${javaResult.players.max}`;
      if (Array.isArray(javaResult.players.sample)) {
        playerList = javaResult.players.sample
          .map(p => cleanMotd(p && p.name))
          .filter(Boolean);
      }
    }

    const rawVersion = javaResult.version && javaResult.version.name ? javaResult.version.name : '';
    const cleanedVersion = cleanMotd(rawVersion);
    if (cleanedVersion && cleanedVersion.length <= 25 && !cleanedVersion.toLowerCase().includes('online')) {
      version = cleanedVersion;
    }

    let rawMotd = '';
    if (javaResult.motd) {
      rawMotd = javaResult.motd.clean || javaResult.motd.raw || '';
    }
    const cleanedMotd = cleanMotd(rawMotd);
    if (cleanedMotd) motd = cleanedMotd;
  } else if (bedrockOnline && bedrockResult) {
    if (bedrockResult.players && bedrockResult.players.online !== undefined) {
      playersOnline = `${bedrockResult.players.online}/${bedrockResult.players.max}`;
    }
    const cleanedVersion = cleanMotd(bedrockResult.version && bedrockResult.version.name);
    if (cleanedVersion) version = cleanedVersion;
    const cleanedMotd = cleanMotd(bedrockResult.motd && (bedrockResult.motd.clean || bedrockResult.motd.raw));
    if (cleanedMotd) motd = cleanedMotd;
  }

  // "sample" often comes back empty even with players online — try Query protocol as a backup.
  if (javaOnline && playerList.length === 0) {
    const onlineCount = parseInt(playersOnline.split('/')[0], 10) || 0;
    if (onlineCount > 0) {
      playerList = await fetchPlayerListViaQuery(javaHost, javaPort);
    }
  }

  return { isOnline: true, playersOnline, version, motd, playerList, javaIp, bedrockIp, bedrockOnline };
}

// Rich, minimal panel embed — Java IP, Bedrock IP, live player count + names.
// Used only by the owner-only auto-updating panel (`sp smp-panel`).
// The Bedrock address is always shown (it's a fixed, known value) — only the
// small status dot next to it reflects whether the live ping succeeded, since
// Bedrock pings can fail intermittently even while the server is genuinely up.
function buildPanelEmbed(data) {
  const { isOnline, playersOnline, version, motd, playerList, javaIp, bedrockIp, bedrockOnline } = data;

  const embed = new EmbedBuilder().setTimestamp();

  if (!isOnline) {
    return embed
      .setTitle('🔴 Nethrion SMP — Offline')
      .setColor('#e74c3c')
      .addFields(
        { name: '🌐 Java IP', value: `\`${javaIp}\``, inline: true },
        { name: '📱 Bedrock IP', value: `\`${bedrockIp}\``, inline: true }
      )
      .setDescription('Server is currently offline or restarting.')
      .setFooter({ text: 'Auto-updates every 30s' });
  }

  embed
    .setTitle('🟢 Nethrion SMP — Online')
    .setColor('#2ecc71')
    .addFields(
      { name: '🌐 Java IP', value: `\`${javaIp}\``, inline: true },
      { name: `📱 Bedrock IP ${bedrockOnline ? '🟢' : '🟠'}`, value: `\`${bedrockIp}\``, inline: true },
      { name: '👥 Players', value: `\`${playersOnline}\``, inline: true },
      { name: '🧩 Version', value: `\`${version}\``, inline: true }
    );

  if (playerList.length > 0) {
    const shown = playerList.slice(0, 6);
    const extra = playerList.length > shown.length ? ` +${playerList.length - shown.length} more` : '';
    embed.addFields({ name: '🎮 Online Now', value: shown.join(', ') + extra, inline: false });
  }

  embed.setDescription(`*${motd.length > 90 ? motd.slice(0, 90) + '…' : motd}*`);
  embed.setFooter({ text: bedrockOnline ? 'Auto-updates every 30s' : 'Auto-updates every 30s • Bedrock ping unreachable right now' });
  return embed;
}

async function updateMCPanel() {
  const db = loadData();
  if (!db.mcPanel || !db.mcPanel.channelId || !db.mcPanel.messageId) return;

  try {
    const channel = await client.channels.fetch(db.mcPanel.channelId).catch((e) => {
      console.error('[MC Panel] Could not fetch channel:', e.message);
      return null;
    });
    if (!channel) return;

    const message = await channel.messages.fetch(db.mcPanel.messageId).catch((e) => {
      console.error('[MC Panel] Could not fetch panel message (was it deleted?):', e.message);
      return null;
    });
    if (!message) return;

    const data = await fetchFullStatus(NETHRION_JAVA_HOST, NETHRION_JAVA_PORT, NETHRION_BEDROCK_HOST, NETHRION_BEDROCK_PORT);
    const embed = buildPanelEmbed(data);

    await message.edit({ embeds: [embed] });
  } catch (err) {
    console.error('[MC Panel Error]:', err.message);
  }
}

async function checkYouTubeUploads() {
  const db = loadData();
  if (!db.ytConfig || !db.ytConfig.channelId || !db.ytConfig.ytChannelId) return;

  try {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${db.ytConfig.ytChannelId}`;
    const res = await fetch(rssUrl);
    const xml = await res.text();

    const videoIdMatch = xml.match(/<yt:videoId>(.*?)<\/yt:videoId>/);
    const titleMatch = xml.match(/<title>(.*?)<\/title>/);

    if (videoIdMatch && videoIdMatch[1]) {
      const latestVideoId = videoIdMatch[1];
      const videoTitle = titleMatch ? titleMatch[1] : 'New Video Uploaded!';

      if (db.ytConfig.lastVideoId !== latestVideoId) {
        db.ytConfig.lastVideoId = latestVideoId;
        saveData(db);

        const channel = await client.channels.fetch(db.ytConfig.channelId).catch(() => null);
        if (!channel) return;

        const videoUrl = `https://www.youtube.com/watch?v=${latestVideoId}`;
        await channel.send({
          content: `🚨 **NEW VIDEO DROP!** @everyone\n> **${videoTitle}**\n\nWatch here: ${videoUrl}`
        });
      }
    }
  } catch (err) {
    console.error('[YouTube RSS Error]:', err.message);
  }
}

client.once('ready', () => {
  console.log(`\n=================================`);
  console.log(`🔥 Spark Bot is ONLINE as ${client.user.tag}`);
  console.log(`=================================\n`);

  // 30s is the safe floor: fast enough to feel "live", but won't risk Discord's
  // message-edit rate limit or hammer the Minecraft server with pings.
  setInterval(updateMCPanel, 30 * 1000);
  setInterval(checkYouTubeUploads, 5 * 60 * 1000);
});

client.on('guildMemberAdd', async (member) => {
  try {
    const defaultRole = member.guild.roles.cache.find(r => r.name.toLowerCase() === 'member');
    if (defaultRole) await member.roles.add(defaultRole).catch(() => {});

    const welcomeChannel = member.guild.channels.cache.find(
      c => c.name.includes('welcome') && c.isTextBased()
    );

    if (welcomeChannel) {
      const welcomeEmbed = new EmbedBuilder()
        .setTitle(`Welcome to ${member.guild.name}, ${member.user.username}! 🔥`)
        .setDescription('Glad to have you here! Explore the community, participate in chat, check out our Minecraft SMP server stats, track your daily activity streaks, and enjoy your stay.')
        .setColor('#2ecc71')
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setTimestamp();

      await welcomeChannel.send({ embeds: [welcomeEmbed] });
    }
  } catch (err) {}
});

async function createTicketForUser(user, guild) {
  const cleanUsername = user.username.toLowerCase().replace(/[^a-z0-9-_]/g, '');
  const channelName = `ticket-${cleanUsername}`;
  
  const existingChannel = guild.channels.cache.find(c => c.name === channelName);
  if (existingChannel) {
    return `❌ You already have an open ticket! Look under **🎫 TICKETS** category.`;
  }

  let category = guild.channels.cache.find(c => c.name === '🎫 TICKETS' && c.type === ChannelType.GuildCategory);
  if (!category) {
    try {
      category = await guild.channels.create({
        name: '🎫 TICKETS',
        type: ChannelType.GuildCategory
      });
    } catch (e) {}
  }

  const adminOverwrites = guild.roles.cache
    .filter(role => role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageChannels))
    .map(role => ({
      id: role.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    }));

  const ticketChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category ? category.id : null,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ...adminOverwrites
    ]
  });

  const ticketEmbed = new EmbedBuilder()
    .setTitle(`🎫 Support Ticket - ${user.username}`)
    .setDescription('Our staff will assist you shortly. Please describe your issue below.')
    .setColor('#2ecc71');

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('🔒 Close Ticket')
      .setStyle(ButtonStyle.Danger)
  );

  await ticketChannel.send({ content: `<@${user.id}>`, embeds: [ticketEmbed], components: [closeRow] });
  return `✅ Your ticket has been created! Check under the **🎫 TICKETS** category on the left sidebar.`;
}

async function updateUserNickname(member, streakCount) {
  try {
    let cleanName = member.displayName.replace(/\s*🔥\d+.*$/, '').trim();
    if (cleanName.length > 24) cleanName = cleanName.substring(0, 24);

    const newNick = `${cleanName} 🔥${streakCount}`;
    if (member.displayName !== newNick) {
      await member.setNickname(newNick).catch(() => {});
    }
  } catch (e) {}
}

async function getOrCreateRole(guild, roleName) {
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
  if (!role) {
    role = await guild.roles.create({
      name: roleName,
      color: '#3498db',
      reason: 'Auto-created for Dynamic Channel Ping Menu'
    });
  }
  return role;
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isStringSelectMenu() && interaction.customId === 'dynamic_role_select') {
    await interaction.deferReply({ ephemeral: true });

    const selectedChannelId = interaction.values[0];
    const channel = interaction.guild.channels.cache.get(selectedChannelId);

    if (!channel) {
      await interaction.editReply({ content: '❌ Selected channel no longer exists!' });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
      return;
    }

    const roleName = `🔔 #${channel.name}`;
    const role = await getOrCreateRole(interaction.guild, roleName);
    const hasRole = interaction.member.roles.cache.has(role.id);

    let replyText = '';
    if (hasRole) {
      await interaction.member.roles.remove(role);
      replyText = `🔴 Removed role: **${roleName}** (Undo successful!)`;
    } else {
      await interaction.member.roles.add(role);
      replyText = `🟢 Added role: **${roleName}**!`;
    }

    await interaction.editReply({ content: replyText });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
  }

  if (interaction.isButton() && interaction.customId === 'anon_btn') {
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('anon_channel_select')
      .setPlaceholder('Select destination channel...')
      .setChannelTypes(ChannelType.GuildText);

    const row = new ActionRowBuilder().addComponents(channelSelect);

    await interaction.reply({
      content: '📌 **Select where you want to post your secret message:**',
      components: [row],
      ephemeral: true
    });
  }

  if (interaction.isChannelSelectMenu() && interaction.customId === 'anon_channel_select') {
    const selectedChannelId = interaction.values[0];
    userSelectedChannels.set(interaction.user.id, selectedChannelId);

    const modal = new ModalBuilder()
      .setCustomId('anon_modal')
      .setTitle('Type Anonymous Message');

    const textInput = new TextInputBuilder()
      .setCustomId('anon_input')
      .setLabel('Your Secret Message')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Write your thoughts here...')
      .setRequired(true)
      .setMaxLength(1000);

    modal.addComponents(new ActionRowBuilder().addComponents(textInput));
    
    await interaction.showModal(modal);
    await interaction.message.delete().catch(() => {});
  }

  if (interaction.isModalSubmit() && interaction.customId === 'anon_modal') {
    const userThought = interaction.fields.getTextInputValue('anon_input');
    const selectedChannelId = userSelectedChannels.get(interaction.user.id);

    const targetChannel = interaction.guild.channels.cache.get(selectedChannelId) || interaction.channel;
    const cleanMsg = `🕶️ **Anonymous:**\n> ${userThought.replace(/\n/g, '\n> ')}`;

    await targetChannel.send({ content: cleanMsg });

    const modLogChannel = interaction.guild.channels.cache.find(
      c => (c.name.includes('mod-logs') || c.name.includes('anon-logs')) && c.isTextBased()
    );

    if (modLogChannel) {
      const logEmbed = new EmbedBuilder()
        .setTitle(`🚨 ANON LOG`)
        .setColor('#e74c3c')
        .addFields(
          { name: 'Sender', value: `${interaction.user.tag} (\`${interaction.user.id}\`)`, inline: true },
          { name: 'Target Channel', value: `<#${targetChannel.id}>`, inline: true },
          { name: 'Content', value: userThought }
        )
        .setTimestamp();
      await modLogChannel.send({ embeds: [logEmbed] }).catch(() => {});
    }

    userSelectedChannels.delete(interaction.user.id);

    await interaction.reply({ content: '⚡', ephemeral: true });
    await interaction.deleteReply().catch(() => {});
  }

  if (interaction.isButton() && interaction.customId === 'create_ticket') {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    const resultMsg = await createTicketForUser(interaction.user, interaction.guild);
    await interaction.editReply({ content: resultMsg });
  }

  if (interaction.isButton() && interaction.customId === 'close_ticket') {
    await interaction.reply({ content: '🔒 Closing ticket and saving transcript...' });

    try {
      const channel = interaction.channel;
      const fetchedMsgs = await channel.messages.fetch({ limit: 100 });
      const sortedMsgs = Array.from(fetchedMsgs.values()).reverse();

      let transcriptText = `NETHRION SMP — TRANSCRIPT\n`;
      transcriptText += `Channel: #${channel.name}\n`;
      transcriptText += `Closed By: ${interaction.user.tag}\n`;
      transcriptText += `Date: ${new Date().toLocaleString()}\n`;
      transcriptText += `----------------------------------------\n\n`;

      let msgCount = 0;
      sortedMsgs.forEach(m => {
        if (!m.author.bot) {
          msgCount++;
          const time = m.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          transcriptText += `[${time}] ${m.author.username}: ${m.content}\n`;
        }
      });

      const filePath = `./transcript-${channel.name}.txt`;
      fs.writeFileSync(filePath, transcriptText);

      const logChannel = interaction.guild.channels.cache.find(
        c => (c.name.includes('mod-logs') || c.name.includes('ticket-logs')) && c.isTextBased()
      );

      if (logChannel) {
        const transcriptEmbed = new EmbedBuilder()
          .setTitle('📁 Support Ticket Closed & Archived')
          .setColor('#2b2d31')
          .addFields(
            { name: '🎫 Ticket Name', value: `\`${channel.name}\``, inline: true },
            { name: '🔒 Closed By', value: `<@${interaction.user.id}>`, inline: true },
            { name: '💬 Total Messages', value: `\`${msgCount}\``, inline: true }
          )
          .setFooter({ text: 'Nethrion SMP Support System' })
          .setTimestamp();

        await logChannel.send({
          embeds: [transcriptEmbed],
          files: [filePath]
        });
      }

      fs.unlinkSync(filePath);
      setTimeout(() => channel.delete().catch(() => {}), 3000);
    } catch (err) {
      console.error('[Transcript Error]:', err.message);
    }
  }
});

// Note: short/ambiguous abbreviations like "mc" and "bc" were removed on purpose —
// they collide with normal words (e.g. "mc" in "Minecraft") and caused false flags.
const badWords = [
  'chutiya', 'chutiye', 'chootiya', 'madarchod', 'madarchood', 'bhenchod', 'behnchod', 'bhosdike',
  'bhosdi', 'gandu', 'gandiya', 'randi', 'randwa', 'kaminey', 'kamina', 'harami',
  'laude', 'loda', 'lund', 'lauda', 'chut', 'choot', 'hijra', 'chhakka', 'bkl', 'tatte',
  'gaand', 'gand', 'jhaat', 'bhadwa', 'bhadwe', 'suar', 'kutte', 'kutta',
  'fuck', 'fucker', 'motherfucker', 'shit', 'bitch', 'asshole', 'bastard',
  'cunt', 'dick', 'pussy', 'cock', 'slut', 'whore', 'nigger', 'retard'
];

// Matches only whole/standalone occurrences of a bad word (not as a substring of
// another normal word), so e.g. "minecraft" or "backup" never falsely trigger.
function containsBadWord(text) {
  const lower = text.toLowerCase();
  return badWords.some(word => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
    return re.test(lower);
  });
}

// Links to platforms that are fine to share (YouTube videos, GIF/clip sites, Discord's
// own media CDN, common image hosts). Anything else with a raw link still gets flagged,
// so scam/phishing links keep getting caught while normal sharing isn't punished.
const SAFE_LINK_DOMAINS = [
  'youtube.com', 'youtu.be', 'music.youtube.com',
  'tenor.com', 'giphy.com', 'klipy.com', 'klipy.co', 'klip.gg',
  'media.discordapp.net', 'cdn.discordapp.com', 'discord.com/channels',
  'imgur.com', 'x.com', 'twitter.com'
];

function isSafeLink(text) {
  const urls = text.match(/https?:\/\/[^\s]+/gi) || [];
  if (urls.length === 0) return true;
  return urls.every(u => {
    try {
      const host = new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
      return SAFE_LINK_DOMAINS.some(d => host === d || host.endsWith('.' + d));
    } catch (e) {
      return false;
    }
  });
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  let content = message.content.trim();
  let lower = content.toLowerCase();
  let cmdString = null;

  if (lower.startsWith('s/') || lower.startsWith('S/')) {
    cmdString = content.slice(2).trim();
  } else if (/^(sp|s)\s+/i.test(content)) {
    cmdString = content.replace(/^(sp|s)\s+/i, '').trim();
  }

  const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);

  if (!isAdmin) {
    const msgContentLower = message.content.toLowerCase();
    const userId = message.author.id;
    let violationReason = null;

    const hasBadWord = containsBadWord(message.content);
    if (hasBadWord) {
      violationReason = 'Toxic / Vulgar Language';
    }

    const hasInvite = msgContentLower.includes('discord.gg/') ||
      msgContentLower.includes('discord.com/invite/') ||
      msgContentLower.includes('discordapp.com/invite/');
    if (hasInvite && !violationReason) {
      violationReason = 'Unauthorized Server Invite Link';
    }

    const hasRawLink = /https?:\/\//i.test(msgContentLower);
    if (hasRawLink && !violationReason && !isSafeLink(message.content)) {
      violationReason = 'Unauthorized / Unrecognized Link';
    }

    if (message.mentions.users.size >= 4 && !violationReason) {
      violationReason = 'Mass Mention Spam';
    }

    if (violationReason) {
      await message.delete().catch(() => {});

      const warningMsg = await message.channel.send(`⚠️ <@${userId}>, inappropriate content is not allowed here. Message deleted.`);
      setTimeout(() => warningMsg.delete().catch(() => {}), 4000);

      let adminLogChannel = message.guild.channels.cache.find(
        c => c.name === 'admin-reports' && c.isTextBased()
      );

      if (!adminLogChannel) {
        adminLogChannel = await message.guild.channels.create({
          name: 'admin-reports',
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: message.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
          ]
        }).catch(() => {});
      }

      if (adminLogChannel) {
        const reportEmbed = new EmbedBuilder()
          .setTitle('🚨 SECURITY INCIDENT REPORT')
          .setColor('#e74c3c')
          .addFields(
            { name: '👤 User', value: `${message.author.tag} (\`${userId}\`)`, inline: true },
            { name: '📌 Channel', value: `<#${message.channel.id}>`, inline: true },
            { name: '⚠️ Violation Type', value: `\`${violationReason}\``, inline: true },
            { name: '💬 Flagged Content', value: `\`\`\`${message.content}\`\`\`` }
          )
          .setTimestamp();

        await adminLogChannel.send({ embeds: [reportEmbed] }).catch(() => {});
      }
      return;
    }
  }

  const db = loadData();
  const userId = message.author.id;
  const today = getTodayString();
  const yesterday = getYesterdayString();

  if (!db.streaks[userId]) {
    db.streaks[userId] = { currentStreak: 1, highestStreak: 1, lastActiveDate: today, totalActiveDays: 1 };
    saveData(db);
    updateUserNickname(message.member, 1);
  } else {
    const userStreak = db.streaks[userId];
    if (userStreak.lastActiveDate !== today) {
      if (userStreak.lastActiveDate === yesterday) {
        userStreak.currentStreak += 1;
      } else {
        userStreak.currentStreak = 1;
      }
      userStreak.highestStreak = Math.max(userStreak.highestStreak, userStreak.currentStreak);
      userStreak.totalActiveDays += 1;
      userStreak.lastActiveDate = today;
      saveData(db);
      updateUserNickname(message.member, userStreak.currentStreak);
    } else {
      updateUserNickname(message.member, userStreak.currentStreak);
    }
  }

  if (!cmdString) return;

  const cmdLower = cmdString.toLowerCase();
  const args = cmdString.split(/\s+/);
  const subCmd = args[0].toLowerCase();

  if (cmdLower === 'lock') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply('❌ Manage Channels permission required!');
    }
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    await message.delete().catch(() => {});
    const lockMsg = await message.channel.send('🔒 **This channel has been locked by an Admin.**');
    setTimeout(() => lockMsg.delete().catch(() => {}), 5000);
    return;
  }

  if (cmdLower === 'unlock') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply('❌ Manage Channels permission required!');
    }
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
    await message.delete().catch(() => {});
    const unlockMsg = await message.channel.send('🔓 **This channel has been unlocked.**');
    setTimeout(() => unlockMsg.delete().catch(() => {}), 5000);
    return;
  }

  // --- USER SPECIFIC LOCK (slock / sunlock) for user or bot ---
  if (subCmd === 'slock') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply('❌ Manage Channels permission required!');
    }
    const targetMember = message.mentions.members.first();
    if (!targetMember) {
      return message.reply('❌ Please mention a user or bot! Usage: `sp slock @user`');
    }
    await message.channel.permissionOverwrites.edit(targetMember.id, { SendMessages: false });
    await message.delete().catch(() => {});
    const slockMsg = await message.channel.send(`🔒 **${targetMember.user.tag} has been locked out of this channel.**`);
    setTimeout(() => slockMsg.delete().catch(() => {}), 5000);
    return;
  }

  if (subCmd === 'sunlock') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply('❌ Manage Channels permission required!');
    }
    const targetMember = message.mentions.members.first();
    if (!targetMember) {
      return message.reply('❌ Please mention a user or bot! Usage: `sp sunlock @user`');
    }
    await message.channel.permissionOverwrites.edit(targetMember.id, { SendMessages: null });
    await message.delete().catch(() => {});
    const sunlockMsg = await message.channel.send(`🔓 **${targetMember.user.tag} has been unlocked in this channel.**`);
    setTimeout(() => sunlockMsg.delete().catch(() => {}), 5000);
    return;
  }

  // --- PROFESSIONAL PURGE SYSTEM ---
  // Modes: `sp purge <count>`, `sp purge @user <count>`, `sp purge @user <minutes>min`
  // Safety: max 100 per run (Discord's own bulk-delete cap), and anything over 20
  // requires the literal word `confirm` at the end — stops accidental/careless mass deletes.
  if (subCmd === 'purge') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('❌ Requires Manage Messages permission!');
    }

    const PURGE_MAX = 100;
    const CONFIRM_THRESHOLD = 20;

    const purgeEmbed = (title, desc, color) =>
      new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp();

    const targetUser = message.mentions.users.first();
    let rest = args.slice(1).filter(a => !a.startsWith('<@'));

    let hasConfirm = false;
    if (rest.length && rest[rest.length - 1].toLowerCase() === 'confirm') {
      hasConfirm = true;
      rest = rest.slice(0, -1);
    }

    const sendResult = async (count, scopeText) => {
      await message.delete().catch(() => {});
      const resultEmbed = purgeEmbed('🧹 Purge Complete', `Deleted **${count}** message${count === 1 ? '' : 's'}${scopeText}.`, '#2ecc71')
        .setFooter({ text: `Purged by ${message.author.tag}` });
      const resultMsg = await message.channel.send({ embeds: [resultEmbed] });
      setTimeout(() => resultMsg.delete().catch(() => {}), 6000);
    };

    // --- User + time window: sp purge @user <minutes>min [confirm] ---
    if (targetUser && rest[0] && /^\d+min$/i.test(rest[0])) {
      const minutes = parseInt(rest[0], 10);
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const cutoff = Date.now() - minutes * 60 * 1000;
      let matched = Array.from(fetched.values())
        .filter(m => m.author.id === targetUser.id && m.createdTimestamp >= cutoff)
        .slice(0, PURGE_MAX);

      if (matched.length === 0) {
        return message.reply({ embeds: [purgeEmbed('❌ No Messages Found', `No messages from **${targetUser.username}** in the last **${minutes}** minute(s).`, '#e74c3c')] });
      }

      if (matched.length > CONFIRM_THRESHOLD && !hasConfirm) {
        return message.reply({ embeds: [purgeEmbed(
          '⚠️ Confirmation Required',
          `You're about to delete **${matched.length}** messages from **${targetUser.username}** (last ${minutes} min).\nAdd \`confirm\` at the end to proceed:\n\`sp purge @${targetUser.username} ${minutes}min confirm\``,
          '#f1c40f'
        )] });
      }

      await message.channel.bulkDelete(matched, true);
      return sendResult(matched.length, ` from **${targetUser.username}** (last ${minutes} min)`);
    }

    // --- User + count: sp purge @user <count> [confirm] ---
    if (targetUser) {
      let count = Math.min(Math.max(parseInt(rest[0], 10) || 10, 1), PURGE_MAX);

      if (count > CONFIRM_THRESHOLD && !hasConfirm) {
        return message.reply({ embeds: [purgeEmbed(
          '⚠️ Confirmation Required',
          `You're about to delete **${count}** messages from **${targetUser.username}**.\nAdd \`confirm\` at the end to proceed:\n\`sp purge @${targetUser.username} ${count} confirm\``,
          '#f1c40f'
        )] });
      }

      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const userMsgs = Array.from(fetched.values()).filter(m => m.author.id === targetUser.id).slice(0, count);

      if (userMsgs.length === 0) {
        return message.reply({ embeds: [purgeEmbed('❌ No Messages Found', `No recent messages found from **${targetUser.username}**.`, '#e74c3c')] });
      }

      await message.channel.bulkDelete(userMsgs, true);
      return sendResult(userMsgs.length, ` from **${targetUser.username}**`);
    }

    // --- Plain count: sp purge <count> [confirm] ---
    const rawCount = parseInt(rest[0], 10);
    if (isNaN(rawCount) || rawCount < 1) {
      return message.reply({ embeds: [purgeEmbed(
        '📖 Purge Command Guide',
        '`sp purge <count>` — delete the last N messages (max 100)\n`sp purge @user <count>` — delete N messages from a specific user\n`sp purge @user <minutes>min` — delete a user\'s messages from the last N minutes\n\nDeleting **more than 20** messages requires adding `confirm` at the end.',
        '#3498db'
      )] });
    }

    const count = Math.min(rawCount, PURGE_MAX);

    if (count > CONFIRM_THRESHOLD && !hasConfirm) {
      return message.reply({ embeds: [purgeEmbed(
        '⚠️ Confirmation Required',
        `You're about to delete **${count}** messages in this channel. This cannot be undone.\nAdd \`confirm\` at the end to proceed:\n\`sp purge ${count} confirm\``,
        '#f1c40f'
      )] });
    }

    await message.channel.bulkDelete(count + 1, true);
    return sendResult(count, ' from this channel');
  }

  if (cmdLower === 'roles-panel') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('❌ Restricted to Admins!');
    }

    const textChannels = message.guild.channels.cache.filter(
      c => c.type === ChannelType.GuildText && 
           !c.name.includes('admin') && 
           !c.name.includes('log') && 
           !c.name.includes('ticket')
    ).first(25);

    if (textChannels.size === 0) {
      return message.reply('❌ No eligible text channels found to create a role panel.');
    }

    const selectOptions = textChannels.map(channel => 
      new StringSelectMenuOptionBuilder()
        .setLabel(`#${channel.name}`)
        .setDescription(`Toggle ping role for #${channel.name}`)
        .setValue(channel.id)
        .setEmoji('🔔')
    );

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('dynamic_role_select')
      .setPlaceholder('Select a channel to get/remove its role...')
      .addOptions(selectOptions);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embed = new EmbedBuilder()
      .setTitle('🎭 DYNAMIC CHANNEL PING SELECTOR')
      .setDescription('Choose a channel from the dropdown below to **toggle** its notification role. Select again anytime to undo/remove it.')
      .setColor('#9b59b6')
      .setFooter({ text: 'Auto-detected from server channels' })
      .setTimestamp();

    await message.channel.send({ embeds: [embed], components: [row] });
    await message.delete().catch(() => {});
    return;
  }

  if (subCmd === 'smp-panel') {
    if (message.author.id !== message.guild.ownerId) {
      return message.reply('❌ This command is restricted to the server owner only!');
    }

    try {
      let reused = false;

      if (db.mcPanel && db.mcPanel.channelId === message.channel.id && db.mcPanel.messageId) {
        const existing = await message.channel.messages.fetch(db.mcPanel.messageId).catch(() => null);
        if (existing) reused = true;
      }

      if (!reused) {
        const initEmbed = new EmbedBuilder()
          .setTitle('⏳ Setting up live SMP panel...')
          .setColor('#f1c40f')
          .setDescription('Connecting to Nethrion SMP...');

        const panelMsg = await message.channel.send({ embeds: [initEmbed] });

        db.mcPanel = { channelId: message.channel.id, messageId: panelMsg.id };
        saveData(db);
      }

      await message.delete().catch(() => {});
      await updateMCPanel();
    } catch (err) {
      console.error('[SMP Panel Setup Error]:', err.message);
      await message.channel.send(`⚠️ Couldn't set up the panel: \`${err.message}\`. Check bot permissions (Send Messages, Manage Messages) in this channel.`).catch(() => {});
    }
    return;
  }

  if (subCmd === 'smp') {
    const smpArgs = cmdString.split(/\s+/);

    if (smpArgs[1] && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('❌ Custom IP check is restricted to Admins! Use `sp smp` directly.');
    }

    let host = NETHRION_JAVA_HOST;
    let port = NETHRION_JAVA_PORT;
    let displayIp = NETHRION_JAVA_HOST;

    if (smpArgs[1]) {
      displayIp = smpArgs[1];
      if (displayIp.includes(':')) {
        const parts = displayIp.split(':');
        host = parts[0];
        port = parseInt(parts[1]) || 25565;
      } else {
        host = displayIp;
        port = 25565;
      }
    }

    const tempMsg = await message.reply('🔍 Fetching live Minecraft status...');

    const data = await fetchJavaStatus(host, port);
    const embed = buildSimpleMCEmbed(displayIp, data);

    return tempMsg.edit({ content: '', embeds: [embed] });
  }

  if (cmdLower === 'ticket') {
    const resultMsg = await createTicketForUser(message.author, message.guild);
    return message.reply(resultMsg);
  }

  if (subCmd === 'streak') {
    const targetMember = message.mentions.members.first() || message.member;
    const targetData = db.streaks[targetMember.id];

    if (!targetData) {
      return message.reply(`❌ ${targetMember.displayName} has not started a streak yet!`);
    }

    let cleanName = targetMember.displayName.replace(/\s*🔥\d+.*$/, '').trim();

    const streakEmbed = new EmbedBuilder()
      .setTitle(`🔥 Streak Profile: ${cleanName} (🔥${targetData.currentStreak})`)
      .setColor('#e67e22')
      .setThumbnail(targetMember.user.displayAvatarURL())
      .addFields(
        { name: '⚡ Current Streak', value: `\`${targetData.currentStreak} Days\` 🔥`, inline: true },
        { name: '🏆 Highest Streak', value: `\`${targetData.highestStreak} Days\``, inline: true },
        { name: '📅 Total Active Days', value: `\`${targetData.totalActiveDays} Days\``, inline: true }
      )
      .setFooter({ text: 'Send 1 message daily to keep your streak active!' })
      .setTimestamp();

    return message.channel.send({ embeds: [streakEmbed] });
  }

  if (cmdLower === 'board') {
    const allUsers = Object.entries(db.streaks)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.currentStreak - a.currentStreak)
      .slice(0, 10);

    if (allUsers.length === 0) {
      return message.reply('No streak leaderboard data available yet!');
    }

    let lbDescription = '';
    for (let i = 0; i < allUsers.length; i++) {
      const u = allUsers[i];
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**#${i + 1}**`;
      lbDescription += `${medal} <@${u.id}> — **${u.currentStreak} Days** 🔥 (Best: ${u.highestStreak})\n`;
    }

    const lbEmbed = new EmbedBuilder()
      .setTitle('🏆 Top 10 Active Streaks Leaderboard')
      .setDescription(lbDescription)
      .setColor('#f1c40f')
      .setTimestamp();

    return message.channel.send({ embeds: [lbEmbed] });
  }

  if (cmdLower === 'help admin') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('❌ This command is restricted to Admins!');
    }

    const adminHelpEmbed = new EmbedBuilder()
      .setTitle('👑 Spark Bot Admin Commands Guide')
      .setColor('#9b59b6')
      .setDescription('Here is the complete list of member and admin commands:')
      .addFields(
        { 
          name: '👤 Member Commands', 
          value: '`sp smp` - Check current Minecraft server status.\n`sp ticket` - Open a private support ticket.\n`sp streak` - View your or a member\'s streak profile.\n`sp board` - View top 10 active streaks leaderboard.\n`sp suggest <idea>` - Send community suggestion.' 
        },
        { 
          name: '👑 Admin Commands', 
          value: '`sp smp-panel` - (Owner only) Setup live auto-updating SMP panel with player list.\n`sp yt-setup <yt_channel_id>` - Setup YouTube upload notifications.\n`sp lock` / `sp unlock` - Channel control.\n`sp slock @user` / `sp sunlock @user` - User/bot channel lock.\n`sp purge <count>` / `sp purge @user <count>` / `sp purge @user <min>min` - Max 100, needs `confirm` at the end if over 20.\n`sp roles-panel` - Post dynamic role panel.' 
        }
      )
      .setFooter({ text: 'Nethrion SMP Admin Control' })
      .setTimestamp();

    return message.channel.send({ embeds: [adminHelpEmbed] });
  }

  if (cmdLower === 'help') {
    const helpEmbed = new EmbedBuilder()
      .setTitle('🔥 Spark Bot Commands Guide')
      .setColor('#3498db')
      .setDescription('Here are all available commands for the server:')
      .addFields(
        { 
          name: '👤 Available Commands', 
          value: '`sp smp` - Check current Minecraft server status.\n`sp ticket` - Open a private support ticket.\n`sp streak` - View your or a member\'s streak profile.\n`sp board` - View top 10 active streaks leaderboard.\n`sp suggest <idea>` - Send community suggestion.' 
        }
      )
      .setFooter({ text: 'Nethrion SMP Community' })
      .setTimestamp();

    return message.channel.send({ embeds: [helpEmbed] });
  }

  if (subCmd === 'yt-setup') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('❌ This command is restricted to Admins!');
    }

    const ytArgs = cmdString.split(/\s+/);
    const ytChannelId = ytArgs[1];

    if (!ytChannelId) {
      return message.reply('❌ Please provide a YouTube Channel ID!');
    }

    db.ytConfig = { channelId: message.channel.id, ytChannelId: ytChannelId, lastVideoId: null };
    saveData(db);

    await message.reply(`✅ YouTube upload notifications locked to this channel!`);
    return;
  }

  if (cmdLower === 'ticket-panel') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('❌ This command is restricted to Admins!');
    }

    const ticketEmbed = new EmbedBuilder()
      .setTitle('Support Tickets')
      .setDescription('Click the button below or type `sp ticket` in chat to open a ticket.')
      .setColor('#3498db');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('create_ticket')
        .setLabel('🎫 Create Ticket')
        .setStyle(ButtonStyle.Success)
    );

    await message.channel.send({ embeds: [ticketEmbed], components: [row] });
    await message.delete().catch(() => {});
  }

  if (cmdLower === 'anon-panel' || cmdLower === 'anon') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('❌ This command is restricted to Admins!');
    }

    const anonEmbed = new EmbedBuilder()
      .setTitle('💬 Anonymous Message')
      .setDescription('Click the button below to send a secret message safely to any channel.')
      .setColor('#3498db');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('anon_btn')
        .setLabel('💬 Send Anonymous Thought')
        .setStyle(ButtonStyle.Primary)
    );

    await message.channel.send({ embeds: [anonEmbed], components: [row] });
    await message.delete().catch(() => {});
  }

  if (subCmd === 'suggest') {
    const suggestionText = cmdString.substring(7).trim();
    if (!suggestionText) {
      return message.reply('❌ Please provide your suggestion! Usage: `sp suggest <your idea>`');
    }

    const suggestionEmbed = new EmbedBuilder()
      .setTitle(`💡 Community Suggestion`)
      .setDescription(suggestionText)
      .setColor('#3498db')
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setFooter({ text: 'React with 👍 or 👎 to vote!' })
      .setTimestamp();

    await message.delete().catch(() => {});
    const suggestionMsg = await message.channel.send({ embeds: [suggestionEmbed] });
    await suggestionMsg.react('👍');
    await suggestionMsg.react('👎');
    return;
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const { member, guild } = newState;

    if (newState.channel) {
      const chName = newState.channel.name.toLowerCase();

      if (chName.includes('join') && chName.includes('create')) {
        const category = newState.channel.parent;

        const newChannel = `🔊 ${member.user.username}'s Room`;
        const createdChannel = await guild.channels.create({
          name: newChannel,
          type: ChannelType.GuildVoice,
          parent: category ? category.id : null,
          permissionOverwrites: [
            {
              id: member.id,
              allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers]
            }
          ]
        });

        await member.voice.setChannel(createdChannel);
        tempVCs.add(createdChannel.id);
      }
    }

    if (oldState.channel && tempVCs.has(oldState.channel.id)) {
      if (oldState.channel.members.size === 0) {
        tempVCs.delete(oldState.channel.id);
        await oldState.channel.delete().catch(() => {});
      }
    }
  } catch (err) {
    console.error('[VC Error]:', err.message);
  }
});

client.login(process.env.DISCORD_TOKEN);