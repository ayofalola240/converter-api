import { promises as asyncfs } from 'fs';
import cheerio from 'cheerio';
import { subjects } from './subjects.js';
import axios from 'axios';
import https from 'https';
import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';


const __filename = fileURLToPath(
    import.meta.url);
const __dirname = dirname(__filename);

let logFilePath = path.join(__dirname, 'error.log');
// Create a logger instance
const logger = winston.createLogger({
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: logFilePath }),
    ],
});

let ANSWERS = [];
let currentSubject;
let BaseFileName;

export const extractJSON = async(filePath, FileName, baseFileName, answers) => {
    BaseFileName = baseFileName;
    currentSubject = subjects[FileName.toUpperCase()];
    
    ANSWERS = [...answers];
    if(ANSWERS.length != currentSubject.totalQuestions){
        logger.error(`Invalid answer keys for ${baseFileName}`)
        throw new Error(`Invalid answer keys for ${baseFileName}`)
    }
    try {
        const inputHtml = await asyncfs.readFile(filePath, 'utf8');
        const $ = cheerio.load(inputHtml);

        $('head').remove();
        $('meta').remove();
        $('style').remove();
        $('*')
            .removeAttr('style')
            .removeAttr('class')
            .removeAttr('face')
            .removeAttr('size')
            .removeAttr('name')
            .removeAttr('lang')
            .removeAttr('dir')
            .removeAttr('align')
            .removeAttr('link')
            .removeAttr('color')
            .removeAttr('vlink');

        let modifiedHtml = $.html()
            .replace(/<\/?font>/g, '')
            .replace(/&nbsp;/g, '')
            .replace(/\s+/g, ' ')
            .replace(/<br>/g, '')
            .replace(/<p>\s*(#startgroup)\s*<\/p>/g, '$1')
            .replace(/<p>\s*(#endgroup)\s*<\/p>/g, '$1')
            .replace(/<p>\s*#(?:<span>)?startgroup(?:<\/span>)?\s*<\/p>/g, '#startgroup')
            .replace(/<p>\s*#(?:<span>)?endgroup(?:<\/span>)?\s*<\/p>/g, '#endgroup')
            .replace(/<p>\s*<\/p>/g, '')
            .replace(/<a>\s*<\/a>/g, '')
            .replace(/(\btype="[^"]*"\s*)\bstart="[^"]*"/, '$1');

        const olRegex = /<ol(?:[^>]*)>/;

        const olMatch = modifiedHtml.match(olRegex);
        if (olMatch) {
            const matchedOl = olMatch[0];
            modifiedHtml = modifiedHtml.replace(olRegex, `<ol start="1"${matchedOl.slice(3)}`);
        } else {
            console.log('No <ol> tag found in the HTML.');
        }
        //Re-number the tags because sometimes the html number labels can contains some wierd values
        let startValue = 1;
        modifiedHtml = modifiedHtml.replace(/<ol\s+start="([^"]+)"\s*>/g, () => {
            return `<ol start="${startValue++}">`;
        });

        fs.writeFileSync(path.join(__dirname, 'data/output', `t${FileName}.html`), modifiedHtml);

        let match;
        const groupMatches = [];
        let ungroupedQuestions;
        let groupedQuestions;

        const groupRegex = /#startgroup([\s\S]*?)#endgroup/g;

        let remainingText = modifiedHtml; // Initialize remainingText with modifiedHtml

        while ((match = groupRegex.exec(remainingText)) !== null) {
            const extractedText = match[1].trim();
            groupMatches.push(extractedText);
        }

        const groupedItems = [];
        groupMatches.forEach((groupMatch) => {
            const instructionRegex = /([\s\S]*?)<ol(?:[^>]*)>/;
            const instructionMatch = groupMatch.match(instructionRegex);

            let instruction = '';
            let modifiedGroupMatch = groupMatch;

            if (instructionMatch) {
                instruction = instructionMatch[1].trim();
                modifiedGroupMatch = groupMatch.replace(instructionMatch[1], '').trim();
            }

            groupedItems.push({
                grouped: true,
                instruction: instruction ? instruction : '<p> </p>',
                groupContent: modifiedGroupMatch,
            });
        });

        groupMatches.forEach((extractedText) => {
            remainingText = remainingText.replace(extractedText, '');
        });

        if (remainingText) {
            const items = [...extractQuestionsAndOptions(remainingText)];
            ungroupedQuestions = { grouped: false, items };
        }

        groupedQuestions = processGroupedItems(groupedItems);

        const combinedQuestions = [...groupedQuestions, ungroupedQuestions];

        const validateJSON = () => {
            let totalItems = 0;
            let hasIssue = false
            combinedQuestions.forEach(group => {
                group.items.forEach(item => {
                    if (item.options.length !== 4) {
                        hasIssue = true;
                        logger.error(`Invalid options(${item.options.length}) for quetsion(${item.order}) of ${baseFileName}`);
                    }
                })
                totalItems = totalItems += group.items.length;
            })
            if (currentSubject.totalQuestions !== totalItems) {
                hasIssue = true
                logger.error(`Invalid total questions(${totalItems}) for ${baseFileName}`)
            }
            return hasIssue;
        }

        if (!validateJSON(combinedQuestions)) {
            await processRequests(combinedQuestions);
            return { status: true, data: combinedQuestions };
        } else {
            return { status: false, data: combinedQuestions }
        }

    } catch (error) {
        console.log(error);
        logger.error(currentSubject.code + ' | ' + JSON.stringify(error.response.data));
    }
};

// async function processRequests(combinedQuestions) {
//   const promises = [];
//   const TOS = currentSubject.tos;
//   for (let i = 0; i < combinedQuestions.length; i++) {
//     const group = combinedQuestions[i];
//     const { items, instruction } = group;

//     if (items.length === 0) {
//       break;
//     }
//     const start = items[0].order;
//     const end = items[items.length - 1].order;

//     if (currentSubject.grouping && group.grouped) {
//       promises.push(
//         ...TOS.map(async (topicItem) => {
//           const { subTopics } = topicItem;

//           return Promise.all(
//             subTopics.map(async (subTopic) => {
//               if (subTopic.hasGroup && start === subTopic.start && end === subTopic.end) {
//                 return createGroupAndItems(group);
//               } else if (!subTopic.hasGroup) {
//                 let newItems = [];
//                 const start = subTopic.start;
//                 const end = subTopic.end;

//                 const groupArray = items.map((item) => ({
//                   ...item,
//                   question: instruction + item.question,
//                 }));

//                 groupArray.forEach((item) => {
//                   if (start <= item.order && end >= item.order) {
//                     newItems.push(item);
//                   }
//                 });

//                 if (newItems.length > 0) {
//                   return createGroupAndItems({
//                     instruction: instruction ? instruction : '<p> </p>',
//                     items: newItems,
//                   });
//                 }
//               }
//             }),
//           );
//         }),
//       );
//     } else if (currentSubject.grouping && !group.grouped) {
//       promises.push(
//         ...TOS.map(async (topicItem) => {
//           const { subTopics } = topicItem;

//           return Promise.all(
//             subTopics.map(async (subTopic) => {
//               let newItems = [];
//               const start = subTopic.start;
//               const end = subTopic.end;
//               items.forEach((item) => {
//                 if (start <= item.order && end >= item.order) {
//                   newItems.push(item);
//                 }
//               });
//               if (newItems.length > 0) {
//                 return createGroupAndItems({ instruction: '<p> </p>', items: newItems });
//               }
//             }),
//           );
//         }),
//       );
//     } else {
//       promises.push(createItems(group.items));
//     }
//   }

//   await Promise.all(promises);

//   return { status: true, data: { message: 'Success' } };
// }

async function processRequests(combinedQuestions) {
    const TOS = currentSubject.tos;

    for (let i = 0; i < combinedQuestions.length; i++) {
        const group = combinedQuestions[i];
        const { items, instruction } = group;

        if (items.length === 0) {
            break;
        }

        const start = items[0].order;
        const end = items[items.length - 1].order;

        if (currentSubject.grouping && group.grouped) {
            for (let j = 0; j < TOS.length; j++) {
                const topicItem = TOS[j];
                const { subTopics } = topicItem;

                for (let k = 0; k < subTopics.length; k++) {
                    const subTopic = subTopics[k];

                    try {
                        if (subTopic.hasGroup && start === subTopic.start && end === subTopic.end) {
                            await createGroupAndItems(group);
                        } else if (!subTopic.hasGroup) {
                            const newItems = items
                                .filter((item) => item.order >= subTopic.start && item.order <= subTopic.end)
                                .map((item) => ({...item, question: instruction + item.question }));
                            if (newItems.length > 0) {
                                await createGroupAndItems({
                                    instruction: instruction ? instruction : '<p> </p>',
                                    items: newItems,
                                });
                            }
                        }
                    } catch (error) {
                        console.log(JSON.stringify(error));
                        // Continue to the next iteration of the loop
                    }
                }
            }
        } else if (currentSubject.grouping && !group.grouped) {
            for (let j = 0; j < TOS.length; j++) {
                const topicItem = TOS[j];
                const { subTopics } = topicItem;

                for (let k = 0; k < subTopics.length; k++) {
                    const subTopic = subTopics[k];
                    const newItems = items.filter(
                        (item) => item.order >= subTopic.start && item.order <= subTopic.end,
                    );

                    try {
                        if (newItems.length > 0) {
                            await createGroupAndItems({ instruction: '<p> </p>', items: newItems });
                        }
                    } catch (error) {
                        console.error('An error occurred:', error.response.data);
                        // Continue to the next iteration of the loop
                    }
                }
            }
        } else {
            let newItems;
            if (group.grouped) {
                newItems = group.items.map((item) => ({
                    ...item,
                    question: instruction + item.question,
                }));
                try {
                    await createItems(newItems);
                } catch (error) {
                    console.log(error);
                }
            } else {
                try {
                    await createItems(group.items);
                } catch (error) {
                    console.log(error);
                }
            }
        }
    }

    return { status: true, data: { message: 'Success' } };
}

const processGroupedItems = (groupedItems) => {
    const groupedQuestions = groupedItems.map((groupItem) => {
        const questions = extractQuestionsAndOptions(groupItem.groupContent);

        return {
            grouped: true,
            instruction: groupItem.instruction,
            items: questions,
        };
    });

    return groupedQuestions;
};

const extractQuestionsAndOptions = (content) => {
    const questionsAndOptionsRegex =
        /<ol(?:[^>]*)start="(\d+)">\s*<li>([\s\S]*?)<\/ol>[\s\S]*?(?=<ol(?:[^>]*)start="\d+">|$)/g;
    const optionsRegex = /<ol(?:[^>]*)type="[^"]*">([\s\S]*?)<\/ol>/g;
    const liRegex = /<li(?:\s+[^>]*)?>([\s\S]*?)<\/li>/g;
    const questionPrefixRegex = /<\/li> <\/ol>(?:(?!<\/li> <\/ol>).)*$/;

    let match;
    const result = [];
    let question = '';
    let order = 1;
    let options = [];
    let questionPrefix = {};

    while ((match = questionsAndOptionsRegex.exec(content)) !== null) {
        order = Number(match[1]);
        let questionText = match[0].trim();

        const optionsMatch = optionsRegex.exec(questionText);
        question = questionText.replace(optionsRegex, '').trim();

        if (optionsMatch) {
            const optionsText = optionsMatch[1];
            let optionsArray = Array.from(optionsText.matchAll(liRegex), (m) => m[1].trim());
            const optionValues = ['igzam1', 'igzam2', 'igzam3', 'igzam4'];

            options = optionsArray.map((option, index) => ({
                option: option.replace(/<\/?p>/g, '').trim(),
                returnValue: optionValues[index],
            }));
        } else {
            question = questionText;
        }

        question = question.replace(/<\/?ol[^>]*>|<\/?li[^>]*>/g, '');

        if (questionText.match(questionPrefixRegex)) {
            const matchResult = questionText.match(questionPrefixRegex)[0].replace(/<\/li>\s*<\/ol>/, '');
            questionPrefix[order] = `<p>${matchResult.trim()}</p>`;
            question = question
                .replace(matchResult, '')
                .replace(/<p><\/p>/g, '')
                .trim();
        }
        let answerObject;
        answerObject = ANSWERS.find((ans) => Object.keys(ans)[0] === String(order));
        result.push({
            question: question ? question : '<p> </p>',
            order: order,
            subject: currentSubject._id || currentSubject.id,
            options: options,
            answer: answerObject ? answerObject[String(order)] : '',
        });
    }

    result.forEach((q) => {
        if (questionPrefix[q.order - 1]) {
            q.question = (questionPrefix[q.order - 1] + ' ' + q.question).replace(/<p><\/p>/g, '').trim();
        }
    });
    const regex = /#startgroup|#endgroup|#end(group|<span>group<\/span>)/g;
    currentSubject.tos.forEach((topic) => {
        topic.subTopics.forEach((subTopic) => {
            result.map((item) => {
                if (item.order >= subTopic.start && item.order <= subTopic.end) {
                    let question = item.question
                        .replace(regex, '')
                        .replace(/<p>\s*<\/p>/g, '')
                        .replace(/<p>\s*<\/p>/g, '')
                        .trim();
                    item.question = question ? question : '<p></p>';
                    item.topic = topic.title;
                    item.topicIndex = topic.index;
                    item.topicId = topic._id || topic.id;
                    item.subTopic = subTopic.title;
                    item.subTopicId = subTopic._id || subTopic.id;
                }
            });
        });
    });
    return result;
};

async function createGroupAndItems(groupedItem) {
    // console.log(JSON.stringify(groupedItem));

    const items = groupedItem.items;
    const instruction = groupedItem.instruction;
    const authToken = process.env.TOKEN;

    const data = {
        instruction,
        groupType: 2,
        subjectId: items[0].subject,
        topic: items[0].topic,
        topicId: items[0].topicId,
        subTopic: items[0].subTopic,
        subTopicId: items[0].subTopicId,
    };
    // Request to create a group
    let groupResponse;
    try {
        groupResponse = await axios({
            method: 'post',
            url: `${process.env.SINGLE_ITEM_URL}/api/v1/groups`,
            data,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/json',
            },
        });
    } catch (error) {
        console.log(error);
    }

    const groupData = groupResponse.data;
    console.log(groupData);

    if (groupData.success) {
        const groupId = groupData.data._id || groupData.data.id;
        console.log(items.length);

        await createItems(items, groupId);

        // items.forEach(async (item) => {
        //   try {
        //     item.group = groupId;
        //     item.batch = BaseFileName;
        //     const itemResponse = await axios({
        //       method: 'post',
        //       url: `${process.env.SINGLE_ITEM_URL}/api/v1/questions`,
        //       data: item,
        //       httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        //       headers: {
        //         Authorization: `Bearer ${authToken}`,
        //         'Content-Type': 'application/json',
        //       },
        //     });

        //     console.log(itemResponse.data);

        //     // Add delay between requests
        //     // await asyncTimeout(1000);
        //   } catch (error) {
        //     console.log(error.response.data);
        //     logger.error(
        //       BaseFileName + ' | ' + ` ${item.order} ` + ' | ' + JSON.stringify(error.response.data),
        //     );
        //   }
        // });
    }
}

// async function createItems(items) {
//   const authToken = process.env.TOKEN;
//   let index;
//   items.forEach(async (item) => {
//     try {
//       index = item.order;
//       item.batch = BaseFileName;
//       console.log(item);
//       // Request to create an item with the group id
//       const itemResponse = await axios({
//         method: 'post',
//         url: `${process.env.SINGLE_ITEM_URL}/api/v1/questions`,
//         data: item,
//         httpsAgent: new https.Agent({ rejectUnauthorized: false }),
//         headers: {
//           Authorization: `Bearer ${authToken}`,
//           'Content-Type': 'application/json',
//         },
//       });
//       console.log(itemResponse.data);
//       // Add delay between requests
//       // await asyncTimeout(1000);
//     } catch (error) {
//       // console.log(error.response.data);
//       logger.error(
//         BaseFileName + ' | ' + ` ${index} ` + ' | ' + JSON.stringify(error.response.data),
//       );
//     }
//   });
// }

async function createItems(items, groupId = null) {
    const authToken = process.env.TOKEN;
    for (const item of items) {
        try {
            if (groupId !== null) {
                item.group = groupId;
            }

            item.batch = BaseFileName;

            const itemResponse = await axios({
                method: 'post',
                url: `${process.env.SINGLE_ITEM_URL}/api/v1/questions`,
                data: item,
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
                headers: {
                    Authorization: `Bearer ${authToken}`,
                    'Content-Type': 'application/json',
                },
            });

            console.log(itemResponse.data);

            // Add delay between requests if needed
            // await asyncTimeout(1000);
        } catch (error) {
            console.log(error.response.data);
            logger.error(`${BaseFileName} | ${item.order} | ${JSON.stringify(error.response.data)}`);
        }
    }
}