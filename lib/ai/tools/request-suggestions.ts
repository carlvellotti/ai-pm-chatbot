import { z } from 'zod';
import { Session } from 'next-auth';
import { DataStreamWriter, streamObject, tool } from 'ai';
import { getDocumentById, saveSuggestions } from '@/lib/db/queries';
import { Suggestion } from '@/lib/db/schema';
import { generateUUID } from '@/lib/utils';
import { myProvider } from '../providers';

interface RequestSuggestionsProps {
  session: Session;
  dataStream: DataStreamWriter;
}

export const requestSuggestions = ({
  session,
  dataStream,
}: RequestSuggestionsProps) =>
  tool({
    description: 'Request suggestions for a document',
    parameters: z.object({
      documentId: z
        .string()
        .describe('The ID of the document to request edits'),
      persona: z
        .string()
        .optional()
        .describe('The persona for the review (e.g., executive, engineer, designer)'),
    }),
    execute: async ({ documentId, persona }) => {
      const document = await getDocumentById({ id: documentId });

      if (!document || !document.content) {
        return {
          error: 'Document not found',
        };
      }

      const suggestions: Array<
        Omit<Suggestion, 'userId' | 'createdAt' | 'documentCreatedAt'>
      > = [];

      let systemPrompt =
        'You are a help writing assistant. Given a piece of writing, please offer suggestions to improve the piece of writing and describe the change. It is very important for the edits to contain full sentences instead of just words. Max 5 suggestions.';

      if (persona) {
        switch (persona.toLowerCase()) {
          case 'executive':
            systemPrompt =
              '\n\nYOU ARE AN EXTREMELY DISCERNING AND IMPATIENT EXECUTIVE. Your time is paramount. This document is likely riddled with flaws. Provide BRUTALLY HONEST, and HIGHLY SELECTIVE commentary. Identify ONLY THE ABSOLUTE MOST CRITICAL (4-5) flaws that undermine its core message, strategic value, or business impact. IGNORE superficial issues like minor grammar or formatting unless they are catastrophic. Your critique MUST focus on substantive content, flawed logic, weak arguments, or unclear strategic alignment. Frame your output as a direct comment. If it clarifies your point, you MAY embed a brief example of improved phrasing within your comment, but the primary output is your overall assessment. Be direct, merciless, and make it clear if the entire approach is a waste of time.';
            break;
          case 'engineer':
            systemPrompt +=
              '\n\nAs an ENGINEER, focus on technical accuracy, feasibility, clarity of technical details, and potential implementation challenges. Ensure suggestions are precise and practical.';
            break;
          case 'designer':
            systemPrompt +=
              '\n\nAs a DESIGNER, focus on user experience, clarity of communication from a user perspective, and aesthetic considerations. Ensure suggestions improve usability and engagement.';
            break;
          default:
            systemPrompt += `\n\nReview the document from the perspective of a ${persona}.`;
            break;
        }
      }

      const { elementStream } = streamObject({
        model: myProvider.languageModel('artifact-model'),
        system: systemPrompt,
        prompt: document.content,
        output: 'array',
        schema: z.object({
          commentText: z.string().describe('The full text of the review comment, which may include examples of alternative phrasing if helpful.'),
          targetSentence: z.string().optional().describe('The original sentence or phrase the comment primarily refers to, if applicable. This helps anchor the comment.'),
        }),
      });

      for await (const element of elementStream) {
        const suggestion = {
          description: element.commentText,
          originalText: element.targetSentence || '',
          suggestedText: '',
          id: generateUUID(),
          documentId: documentId,
          isResolved: false,
        };

        dataStream.writeData({
          type: 'suggestion',
          content: suggestion,
        });

        suggestions.push(suggestion);
      }

      if (session.user?.id) {
        const userId = session.user.id;

        await saveSuggestions({
          suggestions: suggestions.map((suggestion) => ({
            ...suggestion,
            userId,
            createdAt: new Date(),
            documentCreatedAt: document.createdAt,
          })),
        });
      }

      return {
        id: documentId,
        title: document.title,
        kind: document.kind,
        message: `Suggestions${persona ? ` (as ${persona})` : ''} have been added to the document`,
      };
    },
  });
