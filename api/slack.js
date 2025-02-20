const { createServer } = require('http');
const { App, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const winston = require('winston');
require('dotenv').config();

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

// In-memory storage
class RatingStore {
  constructor() {
    this.ratings = new Map();
    this.rateLimit = new Map();
  }

  createRating(requesterId, channelId) {
    const id = Date.now().toString();
    const rating = {
      id,
      requesterId,
      channelId,
      status: 'pending',
      createdAt: new Date()
    };
    this.ratings.set(id, rating);
    return rating;
  }

  getRating(id) {
    return this.ratings.get(id);
  }

  updateRating(id, reviewerId, rating) {
    const existing = this.ratings.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      reviewerId,
      rating,
      status: 'completed'
    };
    this.ratings.set(id, updated);
    return updated;
  }

  checkRateLimit(userId) {
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const userRequests = this.rateLimit.get(userId) || [];
    const recentRequests = userRequests.filter(time => now - time < windowMs);
    this.rateLimit.set(userId, recentRequests);
    return recentRequests.length >= 5;
  }

  addRateLimitEntry(userId) {
    const userRequests = this.rateLimit.get(userId) || [];
    userRequests.push(Date.now());
    this.rateLimit.set(userId, userRequests);
  }
}

const store = new RatingStore();

// Initialize Slack WebClient
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true
});

// Helper function to check if a channel is a DM
function isDMChannel(channelId) {
  return channelId.startsWith('D');
}

async function getUserFromDMChannel(client, channelId) {
  try {
    const result = await client.conversations.info({
      channel: channelId,
    });

    // For DMs, the users array contains the two users in the conversation
    const users = result.channel?.users;
    if (users && users.length === 2) {
      // Exclude the bot's user ID and return the other user's ID
      const botUserId = process.env.SLACK_BOT_USER_ID; // Ensure you have the bot's user ID in your environment variables
      return users.find((user) => user !== botUserId);
    }
    return null;
  } catch (error) {
    logger.error('Error retrieving user from DM channel:', error);
    throw error;
  }
}

async function extractUserIdFromText(client, text) {
  // Handle different formats of user mentions/ids
  let userId = text.trim();
  
  // Handle <@USER_ID> format
  if (userId.startsWith('<@') && userId.endsWith('>')) {
    userId = userId.slice(2, -1);
    // Handle any additional formatting like |username
    if (userId.includes('|')) {
      userId = userId.split('|')[0];
    }
  }

  // Verify the user exists
  try {
    const result = await client.users.info({
      user: userId
    });
    
    if (!result.ok || !result.user) {
      throw new Error('User not found');
    }
    
    return result.user.id;
  } catch (error) {
    logger.error('Error verifying user:', error);
    throw new Error('Invalid user mentioned. Please make sure you @mention a valid user.');
  }
}

async function openDMChannel(client, userId) {
  try {
    // First check if a DM channel already exists
    const conversationsResult = await client.conversations.list({
      types: 'im'
    });

    if (conversationsResult.channels) {
      const existingDM = conversationsResult.channels.find(
        channel => channel.user === userId
      );

      if (existingDM) {
        return existingDM.id;
      }
    }

    // If no existing DM found, try to open a new one
    const result = await client.conversations.open({
      users: userId
    });

    if (!result.ok || !result.channel?.id) {
      throw new Error('Failed to open DM channel');
    }

    return result.channel.id;
  } catch (error) {
    logger.error('Error in openDMChannel:', error);
    throw new Error('Unable to open DM channel with the user. Make sure the bot has the necessary permissions and the user is valid.');
  }
}


async function handleDMRating(client, command) {
  // Extract the user ID from the @mention
  const userMention = command.text.trim();
  const userId = userMention.replace(/^<@(.+)>$/, '$1');

  if (!userId || userId === command.user_id) {
    throw new Error('Please @mention a valid user to rate (you cannot rate yourself)');
  }

  // Try to open a DM channel with the target user
  const dmChannelId = await openDMChannel(client, userId);

  return {
    targetUserId: userId,
    channelId: dmChannelId
  };
}

async function verifyChannelAccess(client, channelId) {
  try {
    // Try to get channel info to verify access
    await client.conversations.info({
      channel: channelId
    });
    return true;
  } catch (error) {
    if (error.data?.error === 'channel_not_found') {
      return false;
    }
    throw error; // Rethrow other errors
  }
}

async function postRatingMessage(client, channelId, requesterId, rating) {
  return await client.chat.postMessage({
    channel: channelId, // Can be a user ID (for DMs) or channel ID (for channels)
    text: `${requesterId} has requested a rating!`, // Fallback text for notifications
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<@${requesterId}> has requested a rating!`
        }
      },
      {
        type: "actions",
        block_id: `rating_${rating.id}`,
        elements: [
          {
            type: "radio_buttons",
            action_id: "star_rating",
            options: [
              { text: { type: "plain_text", text: "⭐" }, value: "1" },
              { text: { type: "plain_text", text: "⭐⭐" }, value: "2" },
              { text: { type: "plain_text", text: "⭐⭐⭐" }, value: "3" },
              { text: { type: "plain_text", text: "⭐⭐⭐⭐" }, value: "4" },
              { text: { type: "plain_text", text: "⭐⭐⭐⭐⭐" }, value: "5" }
            ]
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Submit Rating" },
            action_id: "submit_rating",
            style: "primary"
          }
        ]
      }
    ],
    unfurl_links: false,
    unfurl_media: false
  });
}

async function extractUserIdFromText(client, text) {
  try {
    // Remove @ symbol if present and trim whitespace
    let username = text.trim().replace(/^@/, '');

    // If it's already in <@USER_ID> format, extract the ID
    if (username.startsWith('<@') && username.endsWith('>')) {
      return username.slice(2, -1).split('|')[0];
    }

    // Look up user by email if it looks like an email
    if (username.includes('@') && username.includes('.')) {
      try {
        const result = await client.users.lookupByEmail({
          email: username
        });
        if (result.ok && result.user) {
          return result.user.id;
        }
      } catch (error) {
        // If email lookup fails, continue to username lookup
        logger.debug('Email lookup failed, trying username lookup:', error);
      }
    }

    // List all users and find by username
    const result = await client.users.list();

    if (!result.ok || !result.members) {
      throw new Error('Failed to fetch users list');
    }

    // Try to find user by display name, real name, or username
    const user = result.members.find(member =>
      (member.profile?.display_name?.toLowerCase() === username.toLowerCase()) ||
      (member.profile?.real_name?.toLowerCase() === username.toLowerCase()) ||
      (member.name?.toLowerCase() === username.toLowerCase())
    );

    if (!user) {
      throw new Error('User not found');
    }

    return user.id;
  } catch (error) {
    logger.error('Error in extractUserIdFromText:', error);
    throw new Error('Invalid user mentioned. Please make sure you @mention a valid user.');
  }
}

async function openDMChannel(client, userId) {
  try {
    // Try to open a DM channel
    const result = await client.conversations.open({
      users: userId
    });

    if (!result.ok || !result.channel?.id) {
      throw new Error('Failed to open DM channel');
    }

    return result.channel.id;
  } catch (error) {
    logger.error('Error in openDMChannel:', error);
    throw new Error('Unable to open DM channel with the user. Please try again.');
  }
}

app.command('/rate', async ({ command, ack, respond, client }) => {
  try {
    await ack();

    if (store.checkRateLimit(command.user_id)) {
      await respond({
        response_type: 'ephemeral',
        text: '⚠️ Rate limit exceeded. Please try again later.'
      });
      return;
    }

    let targetId = command.channel_id;
    const isDM = command.channel_name === 'directmessage';

    if (isDM) {
      // Require username in DMs
      if (!command.text) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ Please provide the username you want to rate (e.g. `/rate @username`)'
        });
        return;
      }

      try {
        // Extract and verify user ID from username
        const userId = await extractUserIdFromText(client, command.text);
        
        if (userId === command.user_id) {
          await respond({
            response_type: 'ephemeral',
            text: '⚠️ You cannot rate yourself'
          });
          return;
        }

        // Try to open DM channel
        targetId = await openDMChannel(client, userId);
        
      } catch (error) {
        await respond({
          response_type: 'ephemeral',
          text: `⚠️ ${error.message}`
        });
        return;
      }
    }

    store.addRateLimitEntry(command.user_id);
    const rating = store.createRating(command.user_id, targetId);

    logger.info(`New rating request created by ${command.user_id} in ${isDM ? 'DM' : 'channel'} ${targetId}`);

    try {
      await postRatingMessage(client, targetId, command.user_id, rating);
    } catch (error) {
      logger.error('Error posting rating message:', error);
      await respond({
        response_type: 'ephemeral',
        text: '⚠️ Unable to send rating request. Please verify the username and try again.'
      });
    }

  } catch (error) {
    logger.error('Error handling rate command:', error);
    await respond({
      response_type: 'ephemeral',
      text: `⚠️ An unexpected error occurred: ${error.message}`
    });
  }
});

app.action(/^(star_rating|submit_rating)$/, async ({ action, body, ack, respond, client }) => {
  await ack(); // Acknowledge immediately

  try {
    // Handle the action
    if (action.action_id === 'star_rating') {
      return; // Do nothing for star rating selection
    }

    // Handle submit_rating action
    const ratingId = body.actions[0].block_id.split('_')[1];
    const reviewerId = body.user.id;

    const rating = store.getRating(ratingId);
    if (!rating) {
      throw new Error('Rating request not found');
    }

    if (rating.requesterId === reviewerId) {
      throw new Error('You cannot rate yourself');
    }

    const selectedRating = body.state.values[`rating_${ratingId}`]?.star_rating?.selected_option?.value;
    if (!selectedRating) {
      throw new Error('Please select a rating before submitting');
    }

    store.updateRating(ratingId, reviewerId, parseInt(selectedRating));

    logger.info(`Rating completed: ${reviewerId} rated ${rating.requesterId} with ${selectedRating} stars`);

    // Post the final rating message
    await slackClient.chat.postMessage({
      channel: rating.channelId,
      text: `<@${reviewerId}> rated <@${rating.requesterId}> ${selectedRating} ⭐`,
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Rating submitted on <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|${new Date().toLocaleString()}>`
            }
          ]
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `<@${reviewerId}> rated <@${rating.requesterId}> ${selectedRating} ${'⭐'.repeat(parseInt(selectedRating))}`
          }
        }
      ]
    });

    // Delete the original message
    try {
      await slackClient.chat.delete({
        channel: rating.channelId,
        ts: body.message.ts
      });
    } catch (error) {
      logger.error('Error deleting message:', error);
    }
  } catch (error) {
    logger.error('Error processing action:', error);
    await respond({
      response_type: 'ephemeral',
      text: `Error: ${error.message}`
    });
  }
});

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const payload = req.body;

      // Log the incoming payload for debugging
      logger.info('Incoming payload:', { payload });

      if (payload.type === 'url_verification') {
        return res.json({ challenge: payload.challenge });
      }

      // Parse the nested payload if it exists
      if (payload.payload) {
        const parsedPayload = JSON.parse(payload.payload);
        req.body = parsedPayload; // Replace the body with the parsed payload
      }

      // Handle the request through the receiver
      await receiver.requestHandler(req, res);
    } catch (error) {
      logger.error('Error processing request:', error);
      return res.status(500).json({ error: 'Failed to process request' });
    }
  } else if (req.method === 'GET') {
    res.status(200).json({ status: 'ok' });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};
