const { App, ExpressReceiver } = require('@slack/bolt');
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

// In-memory storage
class RatingStore {
  constructor() {
    this.ratings = new Map();
    this.rateLimit = new Map();
  }

  createRating(requesterId, targetId, channelId) {
    const id = Date.now().toString();
    const rating = {
      id,
      requesterId,
      targetId, // Store the target user's ID
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

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: false,
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

async function extractTargetUser(command) {
  const text = command.text.trim();
  if (!text) {
    return null;
  }

  // Extract user ID from mention format (<@USER_ID>)
  const matches = text.match(/<@([A-Z0-9]+)>/);
  return matches ? matches[1] : null;
}

async function postRatingMessage(client, channelId, requesterId, targetId, ratingId) {
  return await client.chat.postMessage({
    channel: channelId,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<@${requesterId}> has requested to rate <@${targetId}>!`
        }
      },
      {
        type: "actions",
        block_id: `rating_${ratingId}`,
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
    ]
  });
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

    // Extract target user from command
    const targetId = await extractTargetUser(command);
    if (!targetId) {
      await respond({
        response_type: 'ephemeral',
        text: 'Please specify a user to rate (e.g., /rate @username)'
      });
      return;
    }

    // Prevent self-rating
    if (targetId === command.user_id) {
      await respond({
        response_type: 'ephemeral',
        text: 'You cannot rate yourself!'
      });
      return;
    }

    store.addRateLimitEntry(command.user_id);
    const rating = store.createRating(command.user_id, targetId, command.channel_id);

    logger.info(`New rating request created by ${command.user_id} for ${targetId} in channel ${command.channel_id}`);

    // Try to post in the current channel
    try {
      await postRatingMessage(client, command.channel_id, command.user_id, targetId, rating.id);
    } catch (error) {
      if (error.data?.error === 'channel_not_found') {
        // If channel_not_found, try to open a DM
        try {
          const dmResponse = await client.conversations.open({
            users: `${command.user_id},${targetId}`
          });
          
          if (dmResponse.channel && dmResponse.channel.id) {
            // Update the rating's channel ID to the DM channel
            rating.channelId = dmResponse.channel.id;
            await postRatingMessage(client, dmResponse.channel.id, command.user_id, targetId, rating.id);
          }
        } catch (dmError) {
          logger.error('Error opening DM:', dmError);
          throw new Error('Unable to create rating in DM');
        }
      } else {
        throw error;
      }
    }
  } catch (error) {
    logger.error('Error handling rate command:', error);
    await respond({
      response_type: 'ephemeral',
      text: `Sorry, something went wrong. ${error.message}`
    });
  }
});

// The action handler remains mostly the same, just updated to use targetId
app.action(/^(star_rating|submit_rating)$/, async ({ action, body, ack, respond, client }) => {
  await ack();

  try {
    if (action.action_id === 'star_rating') {
      return;
    }

    const ratingId = body.actions[0].block_id.split('_')[1];
    const reviewerId = body.user.id;

    const rating = store.getRating(ratingId);
    if (!rating) {
      throw new Error('Rating request not found');
    }

    if (rating.targetId !== rating.requesterId && reviewerId !== rating.targetId) {
      throw new Error('Only the mentioned user can submit this rating');
    }

    const selectedRating = body.state.values[`rating_${ratingId}`]?.star_rating?.selected_option?.value;
    if (!selectedRating) {
      throw new Error('Please select a rating before submitting');
    }

    store.updateRating(ratingId, reviewerId, parseInt(selectedRating));

    logger.info(`Rating completed: ${reviewerId} rated ${rating.requesterId} with ${selectedRating} stars`);

    await client.chat.postMessage({
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

    try {
      await client.chat.delete({
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
      logger.info('Incoming payload:', { payload });

      if (payload.type === 'url_verification') {
        return res.json({ challenge: payload.challenge });
      }

      if (payload.payload) {
        const parsedPayload = JSON.parse(payload.payload);
        req.body = parsedPayload;
      }

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
