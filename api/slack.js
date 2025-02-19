const { createServer } = require('http');
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

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true, // Changed to true for faster processing
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

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true
});

async function verifyChannelAccess(client, channelId) {
  try {
    await client.conversations.info({
      channel: channelId
    });
    return true;
  } catch (error) {
    if (error.data?.error === 'channel_not_found') {
      return false;
    }
    throw error;
  }
}

async function postRatingMessage(client, channelId, requesterId, rating) {
  try {
    // First verify channel access
    const canAccess = await verifyChannelAccess(client, channelId);
    if (!canAccess) {
      logger.error(`Bot lacks access to channel ${channelId}`);
      throw new Error('Bot lacks channel access');
    }

    logger.info(`Attempting to post message in channel ${channelId}`);
    
    const result = await client.chat.postMessage({
      channel: channelId,
      text: `${requesterId} has requested a rating!`,
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

    logger.info(`Successfully posted message in channel ${channelId}`);
    return result;
  } catch (error) {
    logger.error(`Failed to post message in channel ${channelId}:`, error);
    throw error;
  }
}

// app.command('/rate', async ({ command, ack, respond, client }) => {
//   await ack();

//   try {
//     // Check rate limit first
//     if (store.checkRateLimit(command.user_id)) {
//       await respond({
//         response_type: 'ephemeral',
//         text: '⚠️ Rate limit exceeded. Please try again later.'
//       });
//       return;
//     }

//     // Get the mentioned user from the command text
//     const mentionedUser = command.text.trim().match(/@([A-Za-z0-9_]+)/);
//     if (!mentionedUser) {
//       await respond({
//         response_type: 'ephemeral',
//         text: 'Please mention a user to rate (e.g., /rate @username)'
//       });
//       return;
//     }

//     const targetUserId = mentionedUser[1];
    
//     // Prevent self-rating
//     if (targetUserId === command.user_id) {
//       await respond({
//         response_type: 'ephemeral',
//         text: 'You cannot rate yourself!'
//       });
//       return;
//     }

//     // Use the original channel where the command was issued
//     let targetChannelId = command.channel_id;

//     // For DMs, we'll post in the same DM channel
//     if (command.channel_name === 'directmessage') {
//       try {
//         // Get DM channel info
//         const dmInfo = await client.conversations.info({
//           channel: targetChannelId
//         });
        
//         if (!dmInfo.channel) {
//           throw new Error('Unable to verify DM channel');
//         }
//       } catch (error) {
//         logger.error('Error verifying DM channel:', error);
//         throw new Error('Unable to process rating in DM');
//       }
//     }

//     store.addRateLimitEntry(command.user_id);
//     const rating = store.createRating(command.user_id, targetChannelId);

//     logger.info(`Attempting to post rating message in channel ${targetChannelId} for user ${targetUserId}`);
    
//     try {
//       const messageResult = await client.chat.postMessage({
//         channel: targetChannelId,
//         text: `<@${command.user_id}> has requested to rate <@${targetUserId}>`,
//         blocks: [
//           {
//             type: "section",
//             text: {
//               type: "mrkdwn",
//               text: `<@${command.user_id}> has requested to rate <@${targetUserId}>`
//             }
//           },
//           {
//             type: "actions",
//             block_id: `rating_${rating.id}`,
//             elements: [
//               {
//                 type: "radio_buttons",
//                 action_id: "star_rating",
//                 options: [
//                   { text: { type: "plain_text", text: "⭐" }, value: "1" },
//                   { text: { type: "plain_text", text: "⭐⭐" }, value: "2" },
//                   { text: { type: "plain_text", text: "⭐⭐⭐" }, value: "3" },
//                   { text: { type: "plain_text", text: "⭐⭐⭐⭐" }, value: "4" },
//                   { text: { type: "plain_text", text: "⭐⭐⭐⭐⭐" }, value: "5" }
//                 ]
//               },
//               {
//                 type: "button",
//                 text: { type: "plain_text", text: "Submit Rating" },
//                 action_id: "submit_rating",
//                 style: "primary"
//               }
//             ]
//           }
//         ],
//         unfurl_links: false,
//         unfurl_media: false
//       });

//       logger.info(`Successfully posted rating message with ts: ${messageResult.ts}`);
//     } catch (postError) {
//       logger.error(`Error posting rating message:`, postError);
//       throw postError;
//     }

//   } catch (error) {
//     logger.error('Error handling rate command:', error);
//     await respond({
//       response_type: 'ephemeral',
//       text: `Sorry, something went wrong. ${error.message}`
//     });
//   }
// });

app.command('/rate', async ({ command, ack, respond, client }) => {
  await ack();

  try {
    // Check rate limit first
    if (store.checkRateLimit(command.user_id)) {
      await respond({
        response_type: 'ephemeral',
        text: '⚠️ Rate limit exceeded. Please try again later.'
      });
      return;
    }

    // Get the mentioned user from the command text
    const mentionedUser = command.text.trim().match(/<@([A-Za-z0-9]+)>/);
    if (!mentionedUser) {
      await respond({
        response_type: 'ephemeral',
        text: 'Please mention a user to rate (e.g., /rate @username)'
      });
      return;
    }

    const targetUserId = mentionedUser[1];
    
    // Prevent self-rating
    if (targetUserId === command.user_id) {
      await respond({
        response_type: 'ephemeral',
        text: 'You cannot rate yourself!'
      });
      return;
    }

    let targetChannelId = command.channel_id;

    // Special handling for DMs
    if (command.channel_name === 'directmessage') {
      try {
        // Open a DM channel
        const result = await client.conversations.open({
          users: command.user_id
        });
        
        if (!result.ok || !result.channel || !result.channel.id) {
          throw new Error('Failed to open DM channel');
        }
        
        targetChannelId = result.channel.id;
        logger.info(`Opened DM channel: ${targetChannelId}`);
      } catch (dmError) {
        logger.error('Error opening DM channel:', dmError);
        await respond({
          response_type: 'ephemeral',
          text: 'Unable to send rating request in DM. Please try in a channel instead.'
        });
        return;
      }
    }

    store.addRateLimitEntry(command.user_id);
    const rating = store.createRating(command.user_id, targetChannelId);

    logger.info(`Attempting to post rating message in channel ${targetChannelId} for user ${targetUserId}`);
    
    try {
      const messageResult = await client.chat.postMessage({
        channel: targetChannelId,
        text: `<@${command.user_id}> has requested to rate <@${targetUserId}>`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `<@${command.user_id}> has requested to rate <@${targetUserId}>`
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

      logger.info(`Successfully posted rating message with ts: ${messageResult.ts}`);
    } catch (postError) {
      logger.error(`Error posting rating message:`, postError);
      await respond({
        response_type: 'ephemeral',
        text: 'Unable to post rating message. Please ensure the bot is invited to the channel.'
      });
      return;
    }

  } catch (error) {
    logger.error('Error handling rate command:', error);
    await respond({
      response_type: 'ephemeral',
      text: `Sorry, something went wrong. Please try again or use the command in a channel.`
    });
  }
});

// Update the action handler to also handle DMs properly
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

    if (rating.requesterId === reviewerId) {
      throw new Error('You cannot rate yourself');
    }

    const selectedRating = body.state.values[`rating_${ratingId}`]?.star_rating?.selected_option?.value;
    if (!selectedRating) {
      throw new Error('Please select a rating before submitting');
    }

    store.updateRating(ratingId, reviewerId, parseInt(selectedRating));

    // Post completion message in the original channel
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

    // Delete the original message
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

// Optimized request handler
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      // Handle URL verification immediately
      if (req.body && req.body.type === 'url_verification') {
        return res.json({ challenge: req.body.challenge });
      }

      // Parse payload if needed
      if (req.body && req.body.payload) {
        try {
          const parsedPayload = JSON.parse(req.body.payload);
          req.body = parsedPayload;
        } catch (parseError) {
          logger.error('Error parsing payload:', parseError);
        }
      }

      // Set a shorter timeout for the response
      res.setTimeout(3000, () => {
        if (!res.headersSent) {
          res.status(200).end();
        }
      });

      // Process the request through the receiver
      await Promise.race([
        receiver.requestHandler(req, res),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Request timeout')), 2500)
        )
      ]);

    } catch (error) {
      logger.error('Error processing request:', error);
      if (!res.headersSent) {
        res.status(200).end(); // Still return 200 to Slack
      }
    }
  } else if (req.method === 'GET') {
    res.status(200).json({ status: 'ok' });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};
