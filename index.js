import express from 'express';
import { extractJSON } from './docx.js';
import multer from 'multer';
import fs from 'fs';
import https from 'https';
import cors from 'cors';
import dotenv from 'dotenv';
import FormData from 'form-data';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import csv from 'csv-parser';
import axios from 'axios';
import { promisify } from 'util';
import Question from './models/question.js';
import { convertDocxToHtml, convertDocxToPDF } from './convert.js';
import { subjects } from './subjects.js';
import util from 'util';
import winston from 'winston';
const unlinkAsync = promisify(fs.unlink);
const readdirAsync = util.promisify(fs.readdir);

const app = express();

dotenv.config();

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    cb(null, true);
};
const upload = multer({ storage: storage, fileFilter: fileFilter });

const __filename = fileURLToPath(
    import.meta.url);
const __dirname = dirname(__filename);

app.post('/process-text', upload.single('file'), async(req, res) => {
    let logFilePath = path.join(__dirname, 'completed.log');
    const logger = winston.createLogger({
        transports: [
            new winston.transports.Console(),
            new winston.transports.File({ filename: logFilePath }),
        ],
    });
    try {
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }

        const fileName = req.file.originalname;
        const fileExtension = path.extname(fileName);

        if (fileExtension.toLowerCase() !== '.docx') {
            const binFolderPath = path.join(__dirname, 'data/bin');
            const binFilePath = path.join(binFolderPath, fileName);

            fs.writeFileSync(binFilePath, req.file.buffer);

            return res.json({ success: false, message: 'Invalid file format. Uploaded to bin folder.' });
        }

        let baseFileName = path.basename(fileName, fileExtension);

        const subjectCodePattern = new RegExp(`(${Object.keys(subjects).join('|')})`, 'i');
        // Check if the base filename contains any subject code from the array
        const match = baseFileName.match(subjectCodePattern);
        // If a match is found, use the matched subject code; otherwise, keep the original baseFileName
        const subjectCode = match ? match[0].toUpperCase() : baseFileName;

        const outputPath = path.join(__dirname, 'data/output', `${baseFileName}.html`);

        const inputPath = path.join(__dirname, 'data/input/questions', `${baseFileName}.docx`);

        const completedFolder = path.join(__dirname, 'data/completed');
        const completedQuestionsPath = path.join(completedFolder, 'questions', `${baseFileName}.docx`);
        let completedAnswersPath = path.join(completedFolder, 'answers', `${baseFileName}.csv`);

        const failedQuestionsPath = path.join(completedFolder, 'failed', `${baseFileName}.docx`);

        // Create completed folder if it doesn't exist
        if (!fs.existsSync(completedFolder)) {
            fs.mkdirSync(completedFolder);
            fs.mkdirSync(path.join(completedFolder, 'questions'));
            fs.mkdirSync(path.join(completedFolder, 'answers'));
            fs.mkdirSync(path.join(completedFolder, 'failed'));
        }

        let csvInputPath = path.join(__dirname, 'data/input/answers', `${baseFileName}.csv`);

        if (!fs.existsSync(csvInputPath)) {
            csvInputPath = path.join(__dirname, 'data/input/answers', `${subjectCode}.csv`);

            if (!fs.existsSync(csvInputPath)) {
                fs.renameSync(
                    path.join(__dirname, 'data/input/questions', `${baseFileName}.docx`),
                    failedQuestionsPath,
                );
                return res.status(400).json({ success: false, message: 'CSV file not found.' });
            }
        }

        const parseCsv = () => {
            return new Promise((resolve, reject) => {
                const dataArray = [];
                fs.createReadStream(csvInputPath)
                    .pipe(csv({ headers: ['row'] }))
                    .on('data', (row) => {
                        const optionLetters = [
                            { A: 'igzam1' },
                            { B: 'igzam2' },
                            { C: 'igzam3' },
                            { D: 'igzam4' },
                        ];
                        let response = row['row'];

                        if (response) {
                            response = response.trim();
                        }

                        const matchingOption = optionLetters.find((item) => Object.keys(item)[0] === response);

                        if (matchingOption) {
                            const key = Object.keys(matchingOption)[0];
                            const value = matchingOption[key];
                            const index = dataArray.length + 1;
                            dataArray.push({
                                [`${index}`]: value
                            });
                        }
                    })
                    .on('end', () => {
                        resolve(dataArray);
                    })
                    .on('error', (error) => {
                        reject(error);
                    });
            });
        };

        const processCsvFile = async() => {
            try {
                const data = await parseCsv();

                console.log('CSV file successfully processed.');
                return data;
            } catch (error) {
                console.error('Error reading CSV file:', error.message);
                // throw error;
            }
        };

        const answers = await processCsvFile();

        await convertDocxToHtml(inputPath, outputPath);

        const result = await extractJSON(outputPath, subjectCode, baseFileName, answers);

        if (result.data) {
            fs.writeFileSync(
                path.join(__dirname, 'data/output', `${baseFileName}.json`),
                JSON.stringify(result.data, null, 2),
            );
        }

        removeFiles(path.join(__dirname, 'data/output'));

        if (result.status) {
            logger.info('Completed: ' + baseFileName);
            // fs.renameSync(path.join(inputPath), completedQuestionsPath);
            // fs.renameSync(path.join(csvInputPath), completedAnswersPath);
        } else {
            fs.renameSync(path.join(inputPath), failedQuestionsPath);
        }

        fs.unlinkSync(inputPath);
        fs.unlinkSync(csvInputPath);

        res.json({ success: true, result });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

async function removeFiles(directoryPath) {
    try {
        const files = await readdirAsync(directoryPath);

        // Regular expression to match JSON files with the specified subjectCode
        const jsonRegex = /\.json$/i;

        // Iterate over files and unlink non-matching ones
        await Promise.all(
            files.map(async(file) => {
                const filePath = path.join(directoryPath, file);

                if (!jsonRegex.test(file)) {
                    await unlinkAsync(filePath);
                    console.log(`File ${file} removed successfully.`);
                }
            }),
        );
    } catch (error) {
        console.error('Error removing files:', error);
    }
}

// convert to pdf for preview

app.post('/upload', upload.array('files'), async(req, res) => {
    // Create a logger instance

    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).send('No files uploaded.');
        }

        const uploadedFiles = req.files;
        const pdfFolder = path.join(__dirname, 'data/input/pdfs');
        fs.mkdirSync(pdfFolder, { recursive: true });

        const conversions = uploadedFiles.map(async(uploadedFile) => {
            const fileName = uploadedFile.originalname;
            const fileExtension = path.extname(fileName);

            let destinationFolder;

            if (fileExtension.toLowerCase() === '.docx') {
                destinationFolder = 'questions';
            } else if (fileExtension.toLowerCase() === '.csv') {
                destinationFolder = 'answers';
            } else {
                const binFolderPath = path.join(__dirname, 'data/bin');
                const binFilePath = path.join(binFolderPath, fileName);
                fs.writeFileSync(binFilePath, uploadedFile.buffer);
                return res.json({
                    success: false,
                    message: 'Invalid file format. Uploaded to bin folder.',
                });
            }

            let baseFileName = path.basename(fileName, fileExtension);

            const inputPath = path.join(
                __dirname,
                `data/input/${destinationFolder}`,
                `${baseFileName}${fileExtension}`,
            );

            const outputDirectory = fileExtension.toLowerCase() === '.csv' ? 'answers' : 'questions';
            const inputDirectory = path.join(__dirname, 'data/input', outputDirectory);
            fs.mkdirSync(inputDirectory, { recursive: true });

            const writeStream = fs.createWriteStream(inputPath);
            writeStream.write(uploadedFile.buffer);
            writeStream.end();

            // if (fileExtension === '.docx') {
            //   const pdfFileName = `${baseFileName}.pdf`;
            //   const pdfOutputPath = path.join(pdfFolder, pdfFileName);

            //   await new Promise((resolve, reject) => {
            //     writeStream.on('finish', async () => {
            //       try {
            //         await convertDocxToPDF(inputPath, pdfOutputPath);
            //         resolve();
            //       } catch (err) {
            //         reject(err);
            //       }
            //     });
            //   });
            // }
        });

        await Promise.all(conversions);
        const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;

        res.json({
            success: true,
            message: 'Files uploaded and converted to PDF successfully',
            data: `${baseUrl}/uploaded-files/`,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/uploaded-files/:filename', (req, res) => {
    const pdfFolder = path.join(__dirname, 'data/input/pdfs');
    const filename = req.params.filename;
    const filePath = path.join(pdfFolder, filename);

    fs.stat(filePath, (err, stats) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, error: err.message });
        }
        res.setHeader('Content-Type', 'application/pdf');
        // res.setHeader('Content-Length', stats.size);
        res.setHeader('Content-Disposition', `inline; filename=${filename}`);

        // Pipe the file stream to the response
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
    });
});

app.post('/convert', async(req, res) => {
    try {
        const sourceCsvFolder = path.join(__dirname, 'data/input/answers');
        const outputFolder = path.join(__dirname, 'data/output');

        if (!fs.existsSync(sourceCsvFolder)) {
            return res
                .status(400)
                .json({ success: false, message: 'Source folder for .csv files does not exist.' });
        }

        if (!fs.existsSync(outputFolder)) {
            fs.mkdirSync(outputFolder);
        }

        const csvFiles = fs.readdirSync(sourceCsvFolder).filter((file) => file.endsWith('.csv'));

        for (const csvFile of csvFiles) {
            const sourcePath = path.join(sourceCsvFolder, csvFile);
            const destinationPath = path.join(outputFolder, csvFile);

            fs.copyFileSync(sourcePath, destinationPath);
        }

        const sourceDocxFolder = path.join(__dirname, 'data/input/questions');
        const docxFiles = fs.readdirSync(sourceDocxFolder).filter((file) => file.endsWith('.docx'));

        for (const docxFile of docxFiles) {
            const sourcePath = path.join(sourceDocxFolder, docxFile);

            try {
                const processTextEndpoint = `${req.protocol}://${req.get('host')}${
          req.baseUrl
        }/process-text`;
                const fileBuffer = fs.readFileSync(sourcePath);
                const formData = new FormData();

                formData.append('file', fileBuffer, { filename: docxFile });

                const response = await axios.post(processTextEndpoint, formData, {
                    headers: {
                        ...formData.getHeaders(),
                    },
                });
                // console.log(response.data);
            } catch (error) {
                // Handle the error as needed
                console.error(`Error processing file ${docxFile}:`, error.message);
            }
        }

        res.json({ success: true, message: 'Conversion successful' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/get-all-questions/:subject', async(req, res) => {
    try {
        const subject = req.params.subject;
        const questions = await Question.find({ name: subject });

        if (questions && questions.length > 0) {
            return res.status(200).json({
                success: true,
                message: 'Questions retrieved successfully',
                data: questions,
            });
        } else {
            return res.status(404).json({
                success: false,
                message: 'Questions not found',
            });
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message,
        });
    }
});

app.get('/dashboard', async(req, res) => {
    // total number of questions
    // list all subjects
    let subjectsName = [];
    let totalNumberofQuestions = 0;
    try {
        const allSubjects = await Question.find({});
        allSubjects.forEach((group) => {
            subjectsName.push(group.name);
        });

        const getTotalItems = (dataStructure) => {
            return dataStructure.reduce((total, group) => {
                if (group.items && Array.isArray(group.items)) {
                    return total + group.items.length;
                } else {
                    console.warn("Skipping group without 'items' property:", group);
                    return total;
                }
            }, 0);
        };
        allSubjects.forEach((group) => {
            const allGroups = group.questions;

            console.log(getTotalItems(allGroups));

            totalNumberofQuestions += getTotalItems(allGroups);
        });

        return res.status(200).json({
            success: true,
            message: 'Data retrieved successfully',
            data: { subjectsName, totalNumberofQuestions },
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message,
        });
    }
});

app.get('/subject-details/:subject', async(req, res) => {
    let totalItems = 0;
    try {
        const subject = req.params.subject;
        const questions = await Question.find({ name: subject });
        const questionData = questions[0].questions;

        if (questionData && questionData.length > 0) {
            questionData.forEach((group) => {
                totalItems += group.items.length;
            });

            return res.status(200).json({
                success: true,
                message: 'Questions retrieved successfully',
                number_of_questions: totalItems,
                data: questions,
            });
        } else {
            return res.status(404).json({
                success: false,
                message: 'Questions not found',
            });
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message,
        });
    }
});

app.get('/get-all-subjects', async(req, res) => {
    console.log('GET ALL Subjects');
    try {
        const TOKEN = process.env.TOKEN;

        const { data } = await axios({
            method: 'GET',
            url: `${process.env.SINGLE_ITEM_URL}/api/v1/subjects?limit=50`,
            headers: {
                authorization: `Bearer ${TOKEN}`,
            },
        });
        let parsedSubject = {};
        data.data.forEach((subject) => {
            parsedSubject[subject.code] = subject;
        });
        const content = `export const subjects = ${JSON.stringify(parsedSubject)};`;

        fs.writeFile(path.join(__dirname, './subjects.js'), content, (err) => {
            if (err) {
                console.error(err);
            } else {
                console.log('File written successfully');
            }
        });
    } catch (error) {
        console.error(JSON.stringify(error));
    }
    res.status(200).send('done');
});

app.post('/create-item', async(req, res) => {
    const authToken = process.env.TOKEN;
    try {
        const itemResponse = await axios({
            method: 'post',
            url: `${process.env.SINGLE_ITEM_URL}/api/v1/questions`,
            data: req.body,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/json',
            },
        });
        console.log(itemResponse.data);
        return res.json(itemResponse);
    } catch (error) {
        console.log(JSON.stringify(error));
        return res.json(error);
    }
});
export default app;