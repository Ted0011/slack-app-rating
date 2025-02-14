require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');

// Initialize Express
const expressApp = express();
expressApp.use(express.json());

// Initialize Bolt
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Root route handler
expressApp.get('/', (req, res) => {
  res.send('⚡️ Bolt app is running!');
});

// Define the /slack/rate route explicitly
expressApp.post('/slack/rate', async (req, res) => {
  try {
    const payload = req.body;

    // Log the incoming payload
    console.log('Incoming payload:', JSON.stringify(payload, null, 2));

    // Validate the payload
    if (!payload.command || !payload.trigger_id) {
      throw new Error('Invalid payload: Missing required fields');
    }

    // Acknowledge the request immediately
    res.status(200).send();

    // Handle the slash command
    await app.command('/rate', { ack: () => {}, body: payload, client: app.client });
  } catch (error) {
    console.error('Error processing event:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Slash command handler
app.command('/rate', async ({ ack, body, client }) => {
  await ack();

  // Open rating modal
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'rating_modal',
      title: { type: 'plain_text', text: 'Rate User' },
      blocks: [
        {
          block_id: 'rating_block',
          type: 'input',
          element: {
            type: 'radio_buttons',
            options: Array.from({length: 5}, (_, i) => ({
              text: { type: 'plain_text', text: '⭐'.repeat(i+1) },
              value: (i+1).toString()
            })),
            action_id: 'rating_action'
          },
          label: { type: 'plain_text', text: 'Select Rating' }
        },
        {
          block_id: 'message_block',
          type: 'input',
          element: {
            type: 'plain_text_input',
            multiline: true,
            action_id: 'message_action'
          },
          label: { type: 'plain_text', text: 'Feedback Message' }
        }
      ],
      submit: { type: 'plain_text', text: 'Submit' }
    }
  });
});

// Modal submission handler
app.view('rating_modal', async ({ ack, view, body }) => {
  await ack();

  const rating = view.state.values.rating_block.rating_action.selected_option.value;
  const message = view.state.values.message_block.message_action.value;
  const reviewer = body.user.id;
  const reviewee = view.private_metadata; // Get from command parsing

  // Send DM to reviewer
  await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: reviewer,
    text: `You rated <@${reviewee}> ${rating} stars: ${message}`
  });

  // Send DM to reviewee
  await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: reviewee,
    text: `<@${reviewer}> gave you ${rating} stars: ${message}`
  });
});

// Start Express server
expressApp.listen(process.env.PORT || 3000, () => {
  console.log('⚡️ Bolt app is running on port', process.env.PORT || 3000);
});

