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

// NETHRION SMP defaults; `sp smp-set` overrides them per guild.
const DEFAULT_SMP = {
  javaHost: 'nethrionsmp.pixelforge.gg',
  javaPort: 25565,
  bedrockHost: '15.235.165.81',
  bedrockPort: 26091
};
const REPORT_CHANNEL_NAME = '🚨-【-reports-】';
const STAFF_ROLE_NAMES = ['owner', 'admin', 'moderator', 'trainee', 'helper'];

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initData = { 
      mcPanel: { channelId: null, messageId: null },
      smpConfig: { ...DEFAULT_SMP },
      reports: [],
      activity: {},
      links: {},
      ytConfig: { channelId: null, ytChannelId: null, lastVideoId: null }, 
      streaks: {} 
    };
    saveData(initData);
    return initData;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed.ytConfig) parsed.ytConfig = { channelId: null, ytChannelId: null, lastVideoId: null };
    if (!parsed.mcPanel) {
      if (parsed.mcStatus?.channelId && parsed.mcStatus?.messageId) {
        parsed.mcPanel = { channelId: parsed.mcStatus.channelId, messageId: parsed.mcStatus.messageId };
      } else {
        parsed.mcPanel = { channelId: null, messageId: null };
      }
    }
    return parsed;
  } catch (e) {
    return { mcPanel: { channelId: null, messageId: null }, smpConfig: { ...DEFAULT_SMP }, ytConfig: {}, streaks: {}, reports: [], activity: {}, links: {} };
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
async function fetchMinecraftStatus(kind, host, port, timeoutSeconds = 5) {
  const defaultPort = kind === 'java' ? 25565 : 19132;
  const address = encodeURIComponent(`${host}${port !== defaultPort ? `:${port}` : ''}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, timeoutSeconds * 1000));
  try {
    const response = await fetch(`https://api.mcstatus.io/v2/status/${kind}/${address}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Spark-NETHRION/2.0' }
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(raw || `HTTP ${response.status}`);
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJavaStatus(host, port) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fetchMinecraftStatus('java', host, port, 5);
      if (result?.online) {
        return {
          isOnline: true,
          playersOnline: result.players ? `${result.players.online ?? 0}/${result.players.max ?? '?'}` : '—',
          version: cleanMotd(result.version?.name_clean || '') || 'Unknown',
          motd: cleanMotd(result.motd?.clean || '') || 'Minecraft server',
          playerList: (result.players?.list || []).map(p => p.name_clean || p.name_raw).filter(Boolean),
          retrievedAt: result.retrieved_at || Date.now()
        };
      }
    } catch (_) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 800));
    }
  }
  return { isOnline: false, playersOnline: '—', version: '—', motd: 'Server is offline or unreachable.', playerList: [], retrievedAt: Date.now() };
}

async function fetchFullStatus(javaHost, javaPort, bedrockHost, bedrockPort) {
  const [j, b] = await Promise.allSettled([
    fetchMinecraftStatus('java', javaHost, javaPort, 5),
    fetchMinecraftStatus('bedrock', bedrockHost, bedrockPort, 5)
  ]);
  const java = j.status === 'fulfilled' ? j.value : null;
  const bedrock = b.status === 'fulfilled' ? b.value : null;
  const javaOnline = Boolean(java?.online);
  const bedrockOnline = Boolean(bedrock?.online);
  let playersOnline = '—';
  if (javaOnline && java.players) playersOnline = `${java.players.online ?? 0}/${java.players.max ?? '?'}`;
  else if (bedrockOnline && bedrock.players) playersOnline = `${bedrock.players.online ?? 0}/${bedrock.players.max ?? '?'}`;
  const playerList = javaOnline ? (java.players?.list || []).map(p => p.name_clean || p.name_raw).filter(Boolean) : [];
  return {
    isOnline: javaOnline || bedrockOnline,
    javaOnline,
    bedrockOnline,
    playersOnline,
    version: cleanMotd(java?.version?.name_clean || bedrock?.version?.name || '') || '—',
    motd: cleanMotd(java?.motd?.clean || bedrock?.motd?.clean || '') || 'NETHRION SMP',
    playerList,
    javaIp: javaPort === 25565 ? javaHost : `${javaHost}:${javaPort}`,
    bedrockIp: `${bedrockHost}:${bedrockPort}`,
    bedrockPort,
    retrievedAt: java?.retrieved_at || bedrock?.retrieved_at || Date.now()
  };
}

function trimField(text, max = 1024) {
  const value = String(text || '—').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildSimpleMCEmbed(ip, data) {
  const embed = new EmbedBuilder().setTitle('⛏️ Minecraft Server').setTimestamp();
  if (data.isOnline) {
    return embed.setColor('#2ecc71').setDescription(`🟢 **Online**  ·  ${data.playersOnline} players`)
      .addFields(
        { name: 'Address', value: `\`${ip}\``, inline: true },
        { name: 'Version', value: `\`${trimField(data.version, 80)}\``, inline: true },
        { name: 'Info', value: trimField(data.motd, 400), inline: false }
      );
  }
  return embed.setColor('#e74c3c').setDescription(`🔴 **Offline**  ·  \`${ip}\``)
    .setFooter({ text: 'No clear live response was received.' });
}

function buildPanelEmbed(data) {
  const names = (data.playerList || []).slice(0, 10);
  return new EmbedBuilder()
    .setTitle('⛏️ NETHRION SMP')
    .setColor(data.isOnline ? '#2ecc71' : '#e74c3c')
    .setDescription(`${data.isOnline ? '🟢 **Online**' : '🔴 **Offline**'}  ·  ${data.playersOnline} players`)
    .addFields(
      { name: 'Java', value: `\`${data.javaIp}\`  ${data.javaOnline ? '🟢' : '🔴'}`, inline: true },
      { name: 'Bedrock', value: `\`${data.bedrockIp}\`  ${data.bedrockOnline ? '🟢' : '🔴'}`, inline: true },
      { name: 'Version', value: `\`${trimField(data.version, 80)}\``, inline: true },
      { name: 'Online Now', value: names.length ? trimField(names.join(', '), 900) : 'No player names exposed by the server.', inline: false }
    )
    .setFooter({ text: 'Player names are only shown when exposed by the server • updates every 60s' })
    .setTimestamp();
}

async function updateMCPanel() {
  const db = loadData();
  if (!db.mcPanel?.channelId || !db.mcPanel?.messageId) return;
  try {
    const channel = await client.channels.fetch(db.mcPanel.channelId).catch(() => null);
    if (!channel) return;
    const message = await channel.messages.fetch(db.mcPanel.messageId).catch(() => null);
    if (!message) return;
    const cfg = db.smpConfig || { ...DEFAULT_SMP };
    const data = await fetchFullStatus(cfg.javaHost, cfg.javaPort, cfg.bedrockHost, cfg.bedrockPort);
    await message.edit({ embeds: [buildPanelEmbed(data)] });
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
      const videoTitle = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"') : 'New Video Uploaded!';

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
  setInterval(updateMCPanel, 60 * 1000);
  setTimeout(updateMCPanel, 3000);
  setInterval(checkYouTubeUploads, 5 * 60 * 1000);
  setInterval(() => {
    try {
      const data = loadData();
      data.activity = data.activity || {};
      for (const [day, snapshot] of liveDailyActivity.entries()) data.activity[day] = snapshot;
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14);
      for (const day of Object.keys(data.activity)) if (new Date(day) < cutoff) delete data.activity[day];
      saveData(data);
    } catch (err) { console.error('[Activity Save Error]:', err.message); }
  }, 60 * 1000);
});

function parseMinecraftLinkEvent(message) {
  const text = message.content || '';
  if (!/(account\s+linked|linked\s+account|successfully\s+linked|linked\s+to\s+minecraft)/i.test(text)) return null;
  const member = [...message.mentions.members.values()][0] || null;
  if (!member) return null;
  const blacklist = /^(account|linked|welcome|minecraft|successfully|to|with|discord)$/i;
  const candidates = [...text.matchAll(/\b([A-Za-z0-9_]{3,16})\b/g)].map(m => m[1]).filter(x => !/^unknown$/i.test(x) && !blacklist.test(x));
  return candidates[0] ? { member, username: candidates[0] } : null;
}
async function handleMinecraftLinkEvent(message) {
  const parsed = parseMinecraftLinkEvent(message);
  if (!parsed) return;
  const db = loadData();
  db.links = db.links || {};
  db.links[parsed.member.id] = { minecraftUsername: parsed.username, linkedAt: new Date().toISOString() };
  saveData(db);
  const welcomeChannel = message.guild.channels.cache.find(c => c.isTextBased() && /welcome/i.test(c.name));
  if (welcomeChannel) {
    await welcomeChannel.send({
      content: `🎉 **Account Linked!** Welcome **${parsed.username}** to NETHRION SMP! Make sure to read the SMP rules first.`,
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
}

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

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .replace(/<@&\d+>/g, ' ')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) cur[j + 1] = Math.min(cur[j] + 1, prev[j + 1] + 1, prev[j] + (a[i] === b[j] ? 0 : 1));
    for (let j = 0; j < cur.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}
function roleSimilarity(query, role) {
  const q = normalizeSearchText(query), r = normalizeSearchText(role.name);
  if (!q || !r) return 0;
  if (q === r) return 1;
  if (r.includes(q)) return 0.94;
  if (q.includes(r)) return 0.90;
  return Math.max(0, 1 - levenshtein(q, r) / Math.max(q.length, r.length));
}
function resolveRole(guild, query) {
  const raw = String(query || '').trim();
  const mention = raw.match(/^<@&(\d+)>$/);
  if (mention) {
    const role = guild.roles.cache.get(mention[1]);
    if (role) return { role, ambiguous: [] };
  }
  const normalized = normalizeSearchText(raw);
  const exact = guild.roles.cache.find(r => !r.managed && r.id !== guild.id && normalizeSearchText(r.name) === normalized);
  if (exact) return { role: exact, ambiguous: [] };
  const candidates = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id)
    .map(role => ({ role, score: roleSimilarity(raw, role) }))
    .sort((a, b) => b.score - a.score);
  if (!candidates.length || candidates[0].score < 0.65) return { role: null, ambiguous: [] };
  const [top, second] = candidates;
  if (top.score >= 0.88 && (!second || top.score - second.score >= 0.07)) return { role: top.role, ambiguous: [] };
  return { role: null, ambiguous: candidates.slice(0, 5) };
}
function getStaffRoles(guild) {
  return guild.roles.cache.filter(role => {
    const n = normalizeSearchText(role.name);
    return STAFF_ROLE_NAMES.includes(n) || role.permissions.has(PermissionFlagsBits.Administrator);
  });
}
async function getOrCreateReportsChannel(guild) {
  let channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && normalizeSearchText(c.name) === normalizeSearchText(REPORT_CHANNEL_NAME));
  if (channel) return channel;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] }
  ];
  for (const role of getStaffRoles(guild).values()) {
    overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] });
  }
  return guild.channels.create({ name: REPORT_CHANNEL_NAME, type: ChannelType.GuildText, permissionOverwrites: overwrites, reason: 'Spark private reports channel' });
}
function getMentionedMembers(message) { return [...message.mentions.members.values()]; }
function splitRoleAndMentions(text) {
  const first = String(text || '').search(/<@!?\d+>/);
  return { roleQuery: first === -1 ? String(text || '').trim() : String(text || '').slice(0, first).trim() };
}
function suspiciousUrlReason(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s<>()]+/gi) || [];
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const full = `${host}${url.pathname}`.toLowerCase();
      if (host === 'discord.gg' || (host === 'discord.com' && url.pathname.toLowerCase().startsWith('/invite/'))) return 'Unauthorized Discord invite';
      if (host.includes('xn--')) return 'Potentially deceptive domain';
      if (url.username || url.password) return 'Deceptive URL formatting';
      if (/\.(exe|scr|msi|bat|cmd|ps1|vbs|jar|apk)(?:$|\?)/i.test(full)) return 'Executable download link';
    } catch (_) { return 'Malformed URL'; }
  }
  return null;
}
function isMassMentionAbuse(message) {
  return (message.mentions.everyone && !message.member.permissions.has(PermissionFlagsBits.MentionEveryone)) || message.mentions.users.size >= 8;
}
function normalizeSmpInput(raw) {
  let value = String(raw || '').trim().replace(/^https?:\/\//i, '').split('/')[0];
  let host = value;
  let port = 25565;
  const idx = value.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(value.slice(idx + 1))) {
    host = value.slice(0, idx);
    port = Number(value.slice(idx + 1));
  }
  if (!host || /\s/.test(host) || host.length > 253) throw new Error('Invalid Minecraft host/IP.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  return { host: host.toLowerCase(), port };
}
function canManageRole(member, role, guild) {
  return member.id === guild.ownerId || (member.permissions.has(PermissionFlagsBits.ManageRoles) && member.roles.highest.comparePositionTo(role) > 0);
}
function canBotManageRole(guild, role) {
  const me = guild.members.me;
  return Boolean(me && me.roles.highest.comparePositionTo(role) > 0);
}
async function sendTemporary(channel, content, ms = 5000) {
  const msg = await channel.send({ content }).catch(() => null);
  if (msg) setTimeout(() => msg.delete().catch(() => {}), ms);
  return msg;
}

const liveChannelActivity = new Map();
const liveMessageActivity = new Map();
const liveDailyActivity = new Map();
const reportCooldowns = new Map();

client.on('messageCreate', async (message) => {
  if (!message.guild) return;
  if (message.author.bot || message.webhookId) {
    await handleMinecraftLinkEvent(message).catch(() => {});
    if (message.author.bot) return;
  }

  let content = message.content.trim();
  let lower = content.toLowerCase();
  let cmdString = null;

  if (lower.startsWith('s/') || lower.startsWith('S/')) {
    cmdString = content.slice(2).trim();
  } else if (/^(sp|s)\s+/i.test(content)) {
    cmdString = content.replace(/^(sp|s)\s+/i, '').trim();
  }

  const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);

  // Keep Spark deliberately conservative. Normal slang and normal links stay untouched.
  // Command messages are handled by the command layer and are not auto-moderated as chat.
  if (!isAdmin && !cmdString) {
    let violationReason = null;
    if (containsBadWord(message.content)) violationReason = 'Toxic / abusive language';
    const urlReason = suspiciousUrlReason(message.content);
    if (urlReason && !violationReason) violationReason = urlReason;
    if (isMassMentionAbuse(message) && !violationReason) violationReason = 'Mass mention abuse';

    if (violationReason) {
      await message.delete().catch(() => {});
      await sendTemporary(message.channel, `⚠️ <@${message.author.id}>, that message was removed by Spark.`, 5000);
      const reports = await getOrCreateReportsChannel(message.guild).catch(() => null);
      if (reports) {
        const embed = new EmbedBuilder()
          .setTitle('🚨 Spark Security Report')
          .setColor('#e74c3c')
          .addFields(
            { name: 'User', value: `${message.author.tag} (\`${message.author.id}\`)`, inline: true },
            { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
            { name: 'Reason', value: violationReason, inline: true },
            { name: 'Content', value: message.content ? `\`\`\`\n${message.content.slice(0, 3500)}\n\`\`\`` : '*No text content*' }
          ).setTimestamp();
        await reports.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
      }
      return;
    }
  }

  const db = loadData();
  const activityDay = getTodayString();
  if (!liveDailyActivity.has(activityDay)) liveDailyActivity.set(activityDay, { messages: 0, members: {} });
  const liveDay = liveDailyActivity.get(activityDay);
  liveDay.messages += 1;
  liveDay.members[message.author.id] = (liveDay.members[message.author.id] || 0) + 1;
  liveChannelActivity.set(message.channel.id, { timestamp: Date.now(), count: (liveChannelActivity.get(message.channel.id)?.count || 0) + 1, name: message.channel.name });
  liveMessageActivity.set(message.author.id, Date.now());
  const userId = message.author.id;
  const today = activityDay;
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

  if (subCmd === 'role') {
    if (message.author.id !== message.guild.ownerId && !message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply('❌ You need **Manage Roles** to use this command.');
    const { roleQuery } = splitRoleAndMentions(cmdString.slice(4).trim());
    const targets = getMentionedMembers(message);
    if (!roleQuery || !targets.length) return message.reply('Usage: `sp role <role name> @user @user ...`');
    const resolved = resolveRole(message.guild, roleQuery);
    if (!resolved.role) {
      const choices = resolved.ambiguous.length ? resolved.ambiguous.map(x => `• **${x.role.name}**`).join('\n') : '';
      return message.reply(choices ? `🤔 Close matches — use a role mention or be more specific:\n${choices}` : `❌ I couldn't find a role close enough to **${roleQuery}**.`);
    }
    const role = resolved.role;
    if (role.managed || role.id === message.guild.id) return message.reply('❌ That role cannot be manually assigned.');
    if (!canManageRole(message.member, role, message.guild)) return message.reply('❌ You cannot manage that role because it is above your highest role.');
    if (!canBotManageRole(message.guild, role)) return message.reply('❌ Spark cannot manage that role. Move Spark above it.');
    let added = 0, already = 0, failed = 0;
    for (const member of targets) {
      if (member.roles.cache.has(role.id)) { already++; continue; }
      try { await member.roles.add(role, `Bulk role assignment by ${message.author.tag}`); added++; } catch (_) { failed++; }
    }
    await message.delete().catch(() => {});
    const parts = [`✅ **${role.name}** → ${added} added`];
    if (already) parts.push(`${already} already had it`);
    if (failed) parts.push(`${failed} failed`);
    return sendTemporary(message.channel, parts.join(' • '), 7000);
  }

  if (subCmd === 'rolelist') {
    if (message.author.id !== message.guild.ownerId && !message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply('❌ You need **Manage Roles** to use this command.');
    const roleQuery = cmdString.slice('rolelist'.length).trim();
    if (!roleQuery) return message.reply('Usage: `sp rolelist <role name>`');
    const resolved = resolveRole(message.guild, roleQuery);
    if (!resolved.role) {
      const choices = resolved.ambiguous.length ? resolved.ambiguous.map(x => `• **${x.role.name}**`).join('\n') : '';
      return message.reply(choices ? `🤔 Close matches — use the exact role mention:\n${choices}` : `❌ I couldn't find that role.`);
    }
    await message.guild.members.fetch().catch(() => null);
    const members = [...resolved.role.members.values()].sort((a,b) => a.displayName.localeCompare(b.displayName));
    if (!members.length) return message.reply(`📋 **${resolved.role.name}** has no members.`);
    const totalPages = Math.ceil(members.length / 20);
    for (let i = 0; i < members.length; i += 20) {
      const page = members.slice(i, i + 20);
      const pageNo = Math.floor(i / 20) + 1;
      const embed = new EmbedBuilder()
        .setTitle(`📋 ${resolved.role.name}${totalPages > 1 ? ` • ${pageNo}/${totalPages}` : ''}`)
        .setDescription(page.map((m,n) => `${i+n+1}. ${m.user.tag}`).join('\n'))
        .setColor(resolved.role.color || '#5865F2')
        .setFooter({ text: `${members.length} member${members.length === 1 ? '' : 's'}` });
      await message.channel.send({ embeds: [embed] });
    }
    return;
  }

  if (subCmd === 'report') {
    const target = message.mentions.members.first();
    const reason = cmdString.replace(/^report\s+/i, '').replace(/<@!?\d+>/, '').trim();
    if (!target || !reason) return message.reply('Usage: `sp report @user <reason>`');
    const lastReportAt = reportCooldowns.get(message.author.id) || 0;
    if (Date.now() - lastReportAt < 20000) return message.reply('⏳ Give the report system a few seconds before sending another report.');
    reportCooldowns.set(message.author.id, Date.now());
    if (target.id === message.author.id) return message.reply('❌ You cannot report yourself.');
    if (target.user.bot) return message.reply('❌ Please report a human member.');
    const reports = await getOrCreateReportsChannel(message.guild).catch(() => null);
    if (!reports) return message.reply('❌ I could not access the private reports channel.');
    db.reports = db.reports || [];
    const report = { id: (db.reports.at(-1)?.id || db.reports.length || 0) + 1, reporterId: message.author.id, targetId: target.id, reason: reason.slice(0,1000), createdAt: new Date().toISOString() };
    db.reports.push(report); if (db.reports.length > 500) db.reports = db.reports.slice(-500); saveData(db);
    const embed = new EmbedBuilder().setTitle(`🚨 Report #${String(report.id).padStart(3,'0')}`).setColor('#e74c3c')
      .addFields({ name:'Reporter', value:`<@${report.reporterId}>`, inline:true }, { name:'Reported', value:`<@${report.targetId}>`, inline:true }, { name:'Reason', value:report.reason, inline:false }).setTimestamp();
    await reports.send({ embeds:[embed], allowedMentions:{ parse:[] } });
    await message.delete().catch(()=>{});
    return sendTemporary(message.channel, '✅ Report sent privately to the NETHRION staff.', 5000);
  }

  if (subCmd === 'smp-set') {
    if (message.author.id !== message.guild.ownerId && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('❌ You need **Manage Server** to configure the SMP.');
    const smpArgs = cmdString.split(/\s+/).slice(1);
    if (!smpArgs[0]) return message.reply('Usage: `sp smp-set <java-ip[:port]> [bedrock-ip] [bedrock-port]`');
    try {
      const java = normalizeSmpInput(smpArgs[0]);
      let bedrockHost = java.host, bedrockPort = DEFAULT_BEDROCK_PORT;
      if (smpArgs[1]) bedrockHost = normalizeSmpInput(smpArgs[1]).host;
      if (smpArgs[2]) { bedrockPort = Number(smpArgs[2]); if (!Number.isInteger(bedrockPort) || bedrockPort < 1 || bedrockPort > 65535) throw new Error('Invalid Bedrock port.'); }
      else if (java.host === DEFAULT_SMP.javaHost) { bedrockHost = DEFAULT_SMP.bedrockHost; bedrockPort = DEFAULT_SMP.bedrockPort; }
      db.smpConfig = { javaHost: java.host, javaPort: java.port, bedrockHost, bedrockPort };
      saveData(db);
      return message.reply(`✅ SMP saved.\n> Java: \`${java.host}${java.port !== 25565 ? `:${java.port}` : ''}\`\n> Bedrock: \`${bedrockHost}:${bedrockPort}\``);
    } catch (e) { return message.reply(`❌ ${e.message}`); }
  }

  if (subCmd === 'link') {
    if (message.author.id !== message.guild.ownerId && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('❌ You need **Manage Server** to configure links.');
    const target = message.mentions.members.first();
    const ign = cmdString.replace(/^link\s+/i,'').replace(/<@!?\d+>/,'').trim();
    if (!target || !/^[A-Za-z0-9_]{3,16}$/.test(ign)) return message.reply('Usage: `sp link @discord-user MinecraftIGN`');
    db.links = db.links || {}; db.links[target.id] = { minecraftUsername: ign, linkedAt: new Date().toISOString() }; saveData(db);
    return message.reply(`✅ Linked **${target.user.tag}** → **${ign}**.`);
  }

  if (subCmd === 'health' || subCmd === 'server') {
    if (subCmd === 'health' && message.author.id !== message.guild.ownerId && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('❌ You need **Manage Server** to use this command.');
    const guild = message.guild;
    const now = Date.now();
    const online = guild.members.cache.filter(m => m.presence?.status && m.presence.status !== 'offline').size;
    const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice);
    const activeVoice = [...voiceChannels.values()].filter(c => c.members.size > 0).sort((a,b) => b.members.size - a.members.size);
    const activeText = [...liveChannelActivity.values()].filter(x => now - x.timestamp <= 15*60*1000).sort((a,b) => b.timestamp - a.timestamp).slice(0,5);
    const embed = new EmbedBuilder().setTitle('📡 NETHRION Live').setColor('#5865F2')
      .setDescription(`**${guild.name}**  ·  ${online}/${guild.memberCount} online`)
      .addFields(
        { name:'💬 Text', value: activeText.length ? activeText.map(x => `#${x.name}`).join('\n') : 'Quiet right now', inline:true },
        { name:'🎙️ Voice', value: activeVoice.length ? activeVoice.slice(0,5).map(c => `${c.name} · ${c.members.size}`).join('\n') : 'No active VC', inline:true },
        { name:'👥 Members', value:`${guild.memberCount}`, inline:true },
        { name:'🟢 Online', value:`${online}`, inline:true },
        { name:'🎙️ In VC', value:`${activeVoice.reduce((n,c)=>n+c.members.size,0)}`, inline:true },
        { name:'📅 Today', value:`${liveDailyActivity.get(today)?.messages || db.activity?.[today]?.messages || 0} messages`, inline:true }
      ).setFooter({ text:'Live activity is based on what Spark can currently see.' }).setTimestamp();
    return message.channel.send({ embeds:[embed] });
  }

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
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return message.reply('❌ Manage Roles permission required.');
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
    if (message.author.id !== message.guild.ownerId && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return message.reply('❌ This command requires Manage Server.');
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

    if (smpArgs[1] && message.author.id !== message.guild.ownerId && !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return message.reply('❌ Custom server checks are restricted to server management staff.');
    }

    const smpCfg = db.smpConfig || { ...DEFAULT_SMP };
    let host = smpCfg.javaHost;
    let port = smpCfg.javaPort;
    let displayIp = smpCfg.javaHost;

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
          value: [
            '`sp smp` - Check current Minecraft server status.',
            '`sp ticket` - Open a private support ticket.',
            '`sp streak` - View your or a member\'s streak profile.',
            '`sp board` - View top 10 active streaks leaderboard.',
            '`sp suggest <idea>` - Send community suggestion.',
            '`sp report @user <reason>` - Send a private report.',
            '`sp role <role> @user...` - Bulk-assign a role.',
            '`sp rolelist <role>` - List members with a role.',
            '`sp server` - Show a live Discord activity snapshot.'
          ].join('\n')
        },
        {
          name: '👑 Admin Commands',
          value: [
            '`sp smp-set <java-ip[:port]> [bedrock-ip] [bedrock-port]` - Configure the SMP source.',
            '`sp smp-panel` - Setup the live auto-updating SMP panel.',
            '`sp yt-setup <yt_channel_id>` - Setup YouTube upload notifications.',
            '`sp lock` / `sp unlock` - Channel control.',
            '`sp slock @user` / `sp sunlock @user` - User/bot channel lock.',
            '`sp purge <count>` / `sp purge @user <count>` / `sp purge @user <min>min` - Cleanup recent messages.',
            '`sp roles-panel` - Post the notification-role selector.',
            '`sp link @user MinecraftIGN` - Manually store a Minecraft link when DiscordSRV does not expose it.'
          ].join('\n')
        }
      )
      .setFooter({ text: 'NETHRION operations' })
      .setTimestamp();

    return message.channel.send({ embeds: [adminHelpEmbed] });
  }

  if (cmdLower === 'help') {
    const helpEmbed = new EmbedBuilder()
      .setTitle('🔥 Spark Bot Commands Guide')
      .setColor('#3498db')
      .setDescription('Here are the available commands:')
      .addFields({
        name: 'Commands',
        value: [
          '`sp smp` - Check current Minecraft server status.',
          '`sp ticket` - Open a private support ticket.',
          '`sp streak` - View your streak profile.',
          '`sp board` - View the streak leaderboard.',
          '`sp suggest <idea>` - Send a community suggestion.',
          '`sp report @user <reason>` - Send a private report.',
          '`sp server` - Show a live Discord activity snapshot.'
        ].join('\n')
      })
      .setFooter({ text: 'NETHRION community' })
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

process.on('unhandledRejection', err => console.error('[Unhandled Rejection]', err));
process.on('uncaughtException', err => console.error('[Uncaught Exception]', err));

client.login(process.env.DISCORD_TOKEN);