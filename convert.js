import { promises as fs } from 'fs';
import { promisify } from 'util';
import path from 'path';
import url from 'url';
import async from 'async';
import { execFile } from 'child_process';
import tmp from 'tmp';

const convertWithOptions = async (document, format, output, filter, options, callback) => {
  const tempDirObj = tmp.dirSync({ prefix: 'libreofficeConvert', unsafeCleanup: true });
  const tempDir = tempDirObj.name;

  const installDirObj = tmp.dirSync({ prefix: 'soffice', unsafeCleanup: true });
  const installDir = installDirObj.name;

  try {
    const results = await async.auto({
      soffice: async () => {
        let paths = (options || {}).sofficeBinaryPaths || [];
        switch (process.platform) {
          case 'darwin':
            paths = [...paths, '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
            break;
          case 'linux':
            paths = [
              ...paths,
              '/usr/bin/libreoffice',
              '/usr/bin/soffice',
              '/snap/bin/libreoffice',
              '/opt/libreoffice/program/soffice',
              '/opt/libreoffice7.6/program/soffice',
            ];
            break;
          case 'win32':
            paths = [
              ...paths,
              path.join(process.env['PROGRAMFILES(X86)'], 'LIBREO~1/program/soffice.exe'),
              path.join(process.env['PROGRAMFILES(X86)'], 'LibreOffice/program/soffice.exe'),
              path.join(process.env.PROGRAMFILES, 'LibreOffice/program/soffice.exe'),
            ];
            break;
          default:
            throw new Error(`Operating system not yet supported: ${process.platform}`);
        }

        const availablePaths = await async.filter(paths, async (filePath) => {
          try {
            await fs.access(filePath);
            return true;
          } catch (err) {
            return false;
          }
        });

        if (availablePaths.length === 0) {
          throw new Error('Could not find soffice binary');
        }

        return availablePaths[0];
      },

      saveSource: async () => fs.writeFile(path.join(tempDir, 'source'), document),

      convert: [
        'soffice',
        'saveSource',
        async (results) => {
          const filterParam = filter?.length ? `:${filter}` : '';
          const fmt = !(filter ?? '').includes(' ')
            ? `${format}${filterParam}`
            : `"${format}${filterParam}"`;

          const out = output === 'html' ? 'html:HTML:EmbedImages' : output === 'pdf' ? 'pdf' : '';

          const args = [
            `-env:UserInstallation=${url.pathToFileURL(installDir)}`,
            '--headless',
            '--convert-to',
            out,
            fmt,
            '--outdir',
            tempDir,
            path.join(tempDir, 'source'),
          ];

          return execFile(results.soffice, args, options.execOptions || {});
        },
      ],
      loadDestination: [
        'convert',
        async (results) => {
          const destinationPath = path.join(tempDir, `source${format}`);
          let retryCount = 0;

          const retryLoadDestination = async () => {
            try {
              return await fs.readFile(destinationPath);
            } catch (error) {
              // Check if the error is ENOENT (file not found)
              if (error.code === 'ENOENT') {
                // Log the error (optional)
                console.log('conversion in progress...');

                // Retry for a maximum of 10 times (configurable)
                if (retryCount < (options.asyncOptions?.maxRetries || 10)) {
                  retryCount++;
                  // Wait for the specified interval before retrying (configurable)
                  await new Promise((resolve) =>
                    setTimeout(resolve, options.asyncOptions?.interval || 2000),
                  );
                  // Retry
                  return await retryLoadDestination();
                } else {
                  // Max retries reached, reject and stop retrying
                  throw error;
                }
              } else {
                // For other errors, reject and stop retrying
                throw error;
              }
            }
          };

          return await retryLoadDestination();
        },
      ],
    });
    callback(null, results.loadDestination);
  } catch (err) {
    callback(err);
  } finally {
    // Cleanup of permanent directories needs to be handled appropriately in your application
    tempDirObj.removeCallback();
    installDirObj.removeCallback();
  }
};

const convert = (document, format, output, filter, callback) => {
  convertWithOptions(document, format, output, filter, {}, callback);
};

const convertAsync = promisify(convert);

export const convertDocxToHtml = async (inputPath, outputPath) => {
  try {
    const ext = '.html';
    const output = 'html';

    // Read file
    const docxBuf = await fs.readFile(inputPath);

    // Convert it to pdf format with undefined filter (see Libreoffice docs about filter)
    const htmlBuf = await convertAsync(docxBuf, ext, output, undefined);

    // Here in done you have pdf file which you can save or transfer in another stream
    await fs.writeFile(outputPath, htmlBuf);
  } catch (error) {
    console.log(error);
  }
};

export const convertDocxToPDF = async (inputPath, outputPath) => {
  try {
    const ext = '.pdf';
    const output = 'pdf';
    // Read file
    const docxBuf = await fs.readFile(inputPath);

    // Convert it to pdf format with undefined filter (see Libreoffice docs about filter)
    const htmlBuf = await convertAsync(docxBuf, ext, output, undefined);

    // Here in done you have pdf file which you can save or transfer in another stream
    await fs.writeFile(outputPath, htmlBuf);
  } catch (error) {
    console.log(error);
  }
};
