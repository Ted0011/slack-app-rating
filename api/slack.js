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

/* async function getUserFromDMChannel(client, channelId) {
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
} */

async function getUserFromDMChannel(client, channelId) {
  try {
    // For DMs, we can't use conversations.info to get the users
    // Instead, we should use conversations.members or just use the channel ID directly
    const result = await client.conversations.members({
      channel: channelId,
    });

    if (result.members && result.members.length === 2) {
      // Filter out the bot's ID
      const botUserId = process.env.SLACK_BOT_USER_ID;
      return result.members.find(member => member !== botUserId);
    }
    return null;
  } catch (error) {
    logger.error('Error retrieving user from DM channel:', error);
    throw error;
  }
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

// This could be added as an alternative approach if the above still fails
async function openDirectMessageAndPost(client, userId, requesterId, rating) {
  try {
    // Open a DM with the user
    const result = await client.conversations.open({
      users: userId
    });
    
    if (result.ok && result.channel && result.channel.id) {
      // Post the rating message to the newly opened DM
      await postRatingMessage(client, result.channel.id, requesterId, rating);
      return true;
    }
    return false;
  } catch (error) {
    logger.error('Error opening DM:', error);
    return false;
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

    const targetId = command.channel_id;
    const isDM = isDMChannel(targetId);

    // For DMs, we'll need a different approach
    if (isDM) {
      try {
        logger.info(`DM channel detected: ${targetId}`);
        
        // Extract mentioned user from command text if provided
        let recipientId = null;
        if (command.text && command.text.trim().startsWith('@')) {
          const usernameMention = command.text.trim();
          
          // Try to extract the user ID
          // We might need to look up the user ID from user name if slack doesn't provide it directly
          logger.info(`User mentioned in DM: ${usernameMention}`);
          
          // For now, we'll just log this but continue with the DM channel as is
        }
        
        // For DMs, create the rating using the DM channel
        store.addRateLimitEntry(command.user_id);
        const rating = store.createRating(command.user_id, targetId);
        
        logger.info(`New rating request created by ${command.user_id} in DM channel ${targetId}`);
        
        // Try posting directly to the DM channel
        try {
          await postRatingMessage(slackClient, targetId, command.user_id, rating);
        } catch (postError) {
          logger.error('Error posting to DM channel:', postError);
          await respond({
            response_type: 'ephemeral',
            text: '⚠️ Unable to send rating request in this DM. Please make sure the bot is added to the conversation.'
          });
          return;
        }
      } catch (dmError) {
        logger.error('Error handling DM rate command:', dmError);
        await respond({
          response_type: 'ephemeral',
          text: `⚠️ Error processing DM command: ${dmError.message}`
        });
        return;
      }
    } else {
      // Non-DM channel handling (unchanged)
      const hasAccess = await verifyChannelAccess(slackClient, targetId);
      if (!hasAccess) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ The bot does not have access to this channel. Please add the bot to the channel and try again.'
        });
        return;
      }
      
      store.addRateLimitEntry(command.user_id);
      const rating = store.createRating(command.user_id, targetId);
      
      logger.info(`New rating request created by ${command.user_id} in channel ${targetId}`);
      
      await postRatingMessage(slackClient, targetId, command.user_id, rating);
    }
  } catch (error) {
    logger.error('Error handling rate command:', error);
    await respond({
      response_type: 'ephemeral',
      text: `Sorry, something went wrong. ${error.message}`
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
