import * as request from 'request';
import { debugGmail } from '../debuggers';
import { Integrations } from '../models';
import { IIntegrationDocument } from '../models/Integrations';
import { getAuth, gmailClient } from './auth';
import { createOrGetConversation, createOrGetConversationMessage, createOrGetCustomer } from './store';
import { ICredentials, IMessage, IMessageAdded } from './types';
import { extractEmailFromString, parseBatchResponse, parseMessage } from './util';

/**
 * Get full message with historyId
 */
const syncByHistoryId = async (auth: any, startHistoryId: string) => {
  let response;

  try {
    const historyResponse = await gmailClient.history.list({
      auth,
      userId: 'me',
      startHistoryId,
    });

    const { data = {} } = historyResponse;

    if (!data.history || !data.historyId) {
      debugGmail(`No changes made with given historyId ${startHistoryId}`);
      return;
    }

    const { history = [] } = data;
    const receivedMessages = [];

    // Collection messages only history type is messagesAdded
    for (const item of history) {
      if (item.messagesAdded) {
        receivedMessages.push(...item.messagesAdded);
      }
    }

    if (receivedMessages.length === 0) {
      return debugGmail('No new messages found');
    }

    const singleMessage = receivedMessages.length === 1;

    // Send batch request for multiple messages
    response = {
      batchMessages: !singleMessage && (await sendBatchRequest(auth, receivedMessages)),
      singleMessage: singleMessage && (await sendSingleRequest(auth, receivedMessages)),
    };
  } catch (e) {
    return debugGmail(`Error Google: Failed to syncronize gmail with given historyId ${e}`);
  }

  return response;
};

/**
 * Syncronize gmail with given historyId of mailbox
 */
export const syncPartially = async (receivedEmail: string, credentials: ICredentials, startHistoryId: string) => {
  const integration = await Integrations.findOne({ email: receivedEmail });

  if (!integration) {
    return debugGmail(`Integration not found in syncPartially`);
  }

  const { gmailHistoryId, accountId } = integration;

  debugGmail(`Sync partially gmail messages with ${gmailHistoryId}`);

  let auth;

  try {
    auth = await getAuth(credentials, accountId);
  } catch (e) {
    throw e;
  }

  // Get batched multiple messages or single message
  const syncResponse = await syncByHistoryId(auth, gmailHistoryId);

  if (!syncResponse) {
    return null;
  }

  const { batchMessages, singleMessage } = syncResponse;

  if (!batchMessages && !singleMessage) {
    return debugGmail(`Error Google: Could not get message with historyId in sync partially ${gmailHistoryId}`);
  }

  const messagesResponse = batchMessages ? batchMessages : [singleMessage.data];

  await processReceivedEmails(messagesResponse, integration, receivedEmail);

  // Update current historyId for future message
  integration.gmailHistoryId = startHistoryId;

  await integration.save();
};

/**
 * Create customer, conversation, message
 * according to received emails
 */
const processReceivedEmails = async (
  messagesResponse: any,
  integration: IIntegrationDocument,
  receivedEmail: string,
) => {
  const [firstMessage] = messagesResponse;
  const previousMessageId = firstMessage.messageId;

  messagesResponse.forEach(async (value: IMessage, index: number) => {
    const updatedMessage = parseMessage(value);

    // prevent message duplication
    if (index > 0 && previousMessageId === updatedMessage.messageId) {
      return;
    }

    const { from, reply, messageId, subject, labelIds } = updatedMessage;

    // prevent to store emails by integration
    if (!reply && labelIds.indexOf('SENT') > -1) {
      return;
    }

    const email = extractEmailFromString(from);

    const integrationIds = {
      id: integration._id,
      erxesApiId: integration.erxesApiId,
    };

    // Customer ========
    const customer = await createOrGetCustomer(email, integrationIds);

    // Conversation =========
    const conversationDoc = {
      email,
      subject,
      receivedEmail,
      integrationIds,
      reply,
      customerErxesApiId: customer.erxesApiId,
    };

    const conversation = await createOrGetConversation(conversationDoc);

    // Conversation message ==========
    const conversationIds = {
      id: conversation._id,
      erxesApiId: conversation.erxesApiId,
    };

    const messageDoc = {
      messageId,
      conversationIds,
      message: updatedMessage,
      customerErxesApiId: customer.erxesApiId,
    };

    await createOrGetConversationMessage(messageDoc);
  });
};

/**
 * Send multiple request at once
 */
const sendBatchRequest = (auth: any, messages: IMessageAdded[]) => {
  debugGmail('Sending batch request');

  const { credentials } = auth;
  const { access_token } = credentials;
  const boundary = 'erxes';

  let body = '';

  for (const item of messages) {
    body += `--${boundary}\n`;
    body += 'Content-Type: application/http\n\n';
    body += `GET /gmail/v1/users/me/messages/${item.message.id}?format=full\n`;
  }

  body += `--${boundary}--\n`;

  const headers = {
    'Content-Type': 'multipart/mixed; boundary=' + boundary,
    Authorization: 'Bearer ' + access_token,
  };

  return new Promise((resolve, reject) => {
    request.post(
      'https://www.googleapis.com/batch/gmail/v1',
      {
        body,
        headers,
      },
      (error, response, _body) => {
        if (!error && response.statusCode === 200) {
          const payloads = parseBatchResponse(_body);

          return resolve(payloads);
        }

        return reject(error);
      },
    );
  });
};

/**
 * Single request to get a full message
 */
const sendSingleRequest = async (auth: ICredentials, messages: IMessageAdded[]) => {
  const [data] = messages;
  const { message } = data;

  let response: IMessage;

  debugGmail(`Request to get a single message`);

  try {
    response = await gmailClient.messages.get({
      auth,
      userId: 'me',
      id: message.id,
    });
  } catch (e) {
    return debugGmail(`Error Google: Request to get a single message failed ${e}`);
  }

  return response;
};

/**
 * Get attachment
 */
export const getAttachment = async (messageId: string, attachmentId: string, credentials: ICredentials) => {
  debugGmail('Request to get an attachment');

  try {
    const auth = await getAuth(credentials);
    const response = await gmailClient.messages.attachments.get({
      auth,
      id: attachmentId,
      userId: 'me',
      messageId,
    });

    return response.data || '';
  } catch (e) {
    debugGmail(`Failed to get attachment: ${e}`);
    throw e;
  }
};
