import { HandlerContext } from "./handlerContext.js";
import { xmtpClient } from "./client.js";
import { Config, Handler, SkillHandler } from "../helpers/types.js";
import { DecodedMessage } from "@xmtp/node-sdk";
import { logMessage } from "../helpers/utils.js";
import { DecodedMessage as DecodedMessageV2 } from "@xmtp/xmtp-js";
import { streamMessages } from "./streams.js";
import { findSkill, findSkillGroup } from "./skills.js";
import { Conversation } from "@xmtp/node-sdk";
import { Conversation as V2Conversation } from "@xmtp/xmtp-js";

export async function run(handler: Handler, config?: Config) {
  const { client, v2client } = await xmtpClient(config);
  const { inboxId: address } = client;
  const { address: addressV2 } = v2client;

  // sync and list conversations
  await client.conversations.sync();
  await client.conversations.list();
  const handleMessage = async (
    version: "v3" | "v2",
    message: DecodedMessage | DecodedMessageV2 | undefined,
  ) => {
    const conversation = await getConversation(message, version);
    if (message && conversation) {
      try {
        const { senderInboxId, kind } = message as DecodedMessage;
        const senderAddress = (message as DecodedMessageV2).senderAddress;

        if (
          //If same address do nothin
          senderAddress?.toLowerCase() === addressV2?.toLowerCase() ||
          //If same address do nothin
          // Filter out membership_change messages
          (senderInboxId?.toLowerCase() === address?.toLowerCase() &&
            kind !== "membership_change")
        ) {
          return;
        }
        const context = await HandlerContext.create(
          conversation,
          message,
          { client, v2client },
          config?.skills,
          version,
        );
        if (!context) {
          if (process.env.MSG_LOG === "true")
            console.warn("No context found", message);
          return;
        }
        // Check if the message content triggers a skill
        const { isMessageValid, customHandler } = skillTriggered(context);
        if (isMessageValid && customHandler) await customHandler(context);
        else if (isMessageValid) await handler(context);
      } catch (e) {
        console.log(`error`, e);
      }
    }
  };

  const skillTriggered = (
    context: HandlerContext,
  ): {
    isMessageValid: boolean;
    customHandler: SkillHandler | undefined;
  } => {
    const {
      message: {
        content: { text },
        content,
        typeId,
        sender,
      },
      version,
      client,
      v2client,
      skills,
      group,
    } = context;

    let skillAction = text && skills ? findSkill(text, skills) : undefined;

    const { inboxId: senderInboxId } = client;
    const { address: senderAddress } = v2client;

    const isSameAddress =
      sender.address?.toLowerCase() === senderAddress?.toLowerCase() ||
      (sender.inboxId?.toLowerCase() === senderInboxId.toLowerCase() &&
        typeId !== "group_updated");

    const isSkillTriggered = skillAction?.skill;
    const isExperimental = config?.experimental ?? false;

    const isAddedMemberOrPass =
      typeId === "group_updated" &&
      config?.memberChange &&
      //@ts-ignore
      content?.addedInboxes?.length === 0
        ? false
        : true;

    const isRemoteAttachment = typeId == "remoteStaticAttachment";

    const isAdminSkill = skillAction?.adminOnly ?? false;

    const isAdmin =
      group &&
      (group?.admins.includes(sender.inboxId) ||
        group?.superAdmins.includes(sender.inboxId))
        ? true
        : false;

    const isAdminOrPass = isAdminSkill && !isAdmin ? false : true;

    // Remote attachments work if image:true in runner config
    // Replies only work with explicit mentions from triggers.
    // Text only works with explicit mentions from triggers.
    // Reactions dont work with triggers.

    const isImageValid = isRemoteAttachment && config?.attachments;

    const acceptedType = [
      "text",
      "remoteStaticAttachment",
      "reply",
      "skill",
    ].includes(typeId ?? "");

    const skillGroup =
      typeId === "text" && skills
        ? findSkillGroup(text ?? "", skills)
        : undefined; // Check if the message content triggers a tag
    const isTagged = skillGroup ? true : false;
    const isMessageValid = isSameAddress
      ? false
      : // v2 only accepts text, remoteStaticAttachment, reply
        version == "v2" && acceptedType
        ? true
        : //If its image is also good, if it has a skill image:true
          isImageValid
          ? true
          : //If its not an admin, nope
            !isAdminOrPass
            ? false
            : isExperimental
              ? true
              : //If its a group update but its not an added member, nope
                !isAddedMemberOrPass
                ? false
                : //If it has a skill trigger, good
                  isSkillTriggered
                  ? true
                  : //If it has a tag trigger, good
                    isTagged
                    ? true
                    : false;

    if (process.env.MSG_LOG === "true") {
      console.debug("Message Validation Stream Details:", {
        isSameAddress,
        sender,
        content,
        version,
        acceptedType,
        attachmentDetails: {
          isRemoteAttachment,
          isImageValid,
        },
        adminDetails: {
          isAdminSkill,
          isAdmin,
          isAdminOrPass,
        },
        isAddedMemberOrPass,
        skillsParsed: context.skills?.length,
        taggingDetails: isTagged
          ? {
              tag: skillGroup?.tag,
              hasTagHandler: skillGroup?.tagHandler !== undefined,
            }
          : "No tag detected",
        skillTriggerDetails: isSkillTriggered
          ? {
              skill: skillAction?.skill,
              examples: skillAction?.examples,
              description: skillAction?.description,
              params: skillAction?.params
                ? Object.entries(skillAction.params).map(([key, value]) => ({
                    key,
                    value: {
                      type: value.type,
                      values: value.values,
                      plural: value.plural,
                      default: value.default,
                    },
                  }))
                : undefined,
            }
          : "No skill trigger detected",
        isMessageValid,
      });
    }
    if (isMessageValid) logMessage(`msg_${version}: ` + (text ?? typeId));

    return {
      isMessageValid,
      customHandler: skillAction
        ? skillAction.handler
        : skillGroup
          ? skillGroup.tagHandler
          : undefined,
    };
  };
  const getConversation = async (
    message: DecodedMessage | DecodedMessageV2 | undefined,
    version: "v3" | "v2",
  ): Promise<Conversation | V2Conversation> => {
    return version === "v3"
      ? ((await client.conversations.getConversationById(
          (message as DecodedMessage)?.conversationId as string,
        )) as Conversation)
      : ((message as DecodedMessageV2)?.conversation as V2Conversation);
  };
  // Run both clients' streams concurrently
  await Promise.all([
    streamMessages("v3", handleMessage, client),
    streamMessages("v2", handleMessage, v2client),
  ]);
}
