import * as path from "path";
import * as fs from "fs";
import md5 from "md5";
import { TAbstractFile, TFile, TFolder } from "obsidian";

import {
    ATTACHMENT_URL_REGEXP,
    MARKDOWN_ATTACHMENT_URL_REGEXP,
    EMBED_URL_REGEXP,
    EMBED_METADATA_REGEXP,
    GFM_IMAGE_FORMAT,
    OUTGOING_LINK_REGEXP,
} from "./config";
import MarkdownExportPlugin from "./main";

type CopyMarkdownOptions = {
    file: TAbstractFile;
    outputSubPath: string;
};

export async function getImageLinks(markdown: string) {
    const imageLinks = markdown.matchAll(ATTACHMENT_URL_REGEXP);
    const markdownImageLinks = markdown.matchAll(
        MARKDOWN_ATTACHMENT_URL_REGEXP
    );
    return Array.from(imageLinks).concat(Array.from(markdownImageLinks));
}

export async function getEmbeds(markdown: string) {
    const embeds = markdown.matchAll(EMBED_URL_REGEXP);
    return Array.from(embeds);
}

// get all markdown parameters
export function allMarkdownParams(
    file: TAbstractFile,
    out: Array<CopyMarkdownOptions>,
    outputSubPath = ".",
    parentPath = ""
): Array<CopyMarkdownOptions> {
    try {
        //  dir
        if (!(<TFile>file).extension) {
            for (const absFile of (<TFolder>file).children) {
                if (!(<TFile>absFile).extension) {
                    const extname = absFile.path
                        .replace(file.path, "")
                        .slice(1);
                    const outputSubPath = path.join(parentPath, extname);
                    allMarkdownParams(
                        absFile,
                        out,
                        outputSubPath,
                        outputSubPath
                    );
                } else {
                    out.push({
                        file: absFile,
                        outputSubPath,
                    });
                }
            }
        } else {
            out.push({
                file,
                outputSubPath,
            });
        }
    } catch (e) {
        console.warn("Path Error:" + parentPath);
    }
    return out;
}

export async function tryRun(
    plugin: MarkdownExportPlugin,
    file: TAbstractFile
) {
    // recursive functions are not suitable for this case
    // if ((<TFile>file).extension) {
    // 	return new Promise((resolve) => {
    // 		setTimeout(
    // 			() =>
    // 				resolve(tryCopyMarkdownByRead(plugin, file, outputSubPath)),
    // 			1000
    // 		);
    // 	});
    // }

    try {
        const params = allMarkdownParams(file, []);
        for (const param of params) {
            await tryCopyMarkdownByRead(plugin, param);
        }
    } catch (error) {
        if (!error.message.contains("file already exists")) {
            throw error;
        }
    }
}

export function getResourceOsPath(
    plugin: MarkdownExportPlugin,
    resouorce: TFile | null
): string {
    if (resouorce === null) {
        return ".";
    }
    const appPath = plugin.app.vault.getResourcePath(resouorce);

    const match = appPath.match(/app:\/\/(.*?)\//);
    if (match) {
        const hash = match[1];
        const result = appPath
            .replace(`app://${hash}/`, process.platform === "win32" ? "" : "/")
            .split("?")[0];
        return decodeURIComponent(result);
    }
    return ".";
}

/**
 *
 * @param path a/b/c.md
 * @returns click path: unix: ../../ or windows(default): ../../, but need: ../
 */
export function getClickSubRoute(p: string, sep = "/"): string {
    if (p === ".") {
        return "";
    }
    const parentLevels = p.split(sep).length;
    const parentRoute = ".." + sep;

    return parentRoute.repeat(parentLevels);
}

export function fileExists(path: string): boolean {
    try {
        return fs.statSync(path).isFile();
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        } else {
            throw error;
        }
    }
}

/**
 *  try create folder
 * @param plugin
 * @param p path to create
 */
export async function tryCreateFolder(plugin: MarkdownExportPlugin, p: string) {
    try {
        if (p.startsWith("/") || path.win32.isAbsolute(p)) {
            fs.mkdirSync(p, { recursive: true });
        } else {
            await plugin.app.vault.createFolder(p);
        }
    } catch (error) {
        if (!error.message.contains("Folder already exists")) {
            throw error;
        }
    }
}

/**
 * try create file
 * @param plugin
 * @param p path to create
 * @param data
 */
export async function tryCreate(
    plugin: MarkdownExportPlugin,
    p: string,
    data: string
) {
    const override = plugin.settings.overrideExisting;
    try {
        if (p.startsWith("/") || path.win32.isAbsolute(p)) {
            if (override && fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
            fs.writeFileSync(p, data);
        } else {
            if (override && (await plugin.app.vault.adapter.exists(p))) {
                await plugin.app.vault.adapter.remove(p);
            }
            await plugin.app.vault.create(p, data);
        }
    } catch (error) {
        if (!error.message.contains("file already exists")) {
            throw error;
        }
    }
}

export async function tryCopyImage(
    plugin: MarkdownExportPlugin,
    filename: string,
    contentPath: string
) {
    try {
        await plugin.app.vault.adapter
            .read(contentPath)
            .then(async (content) => {
                const imageLinks = await getImageLinks(content);
                for (const index in imageLinks) {
                    const urlEncodedImageLink =
                        imageLinks[index][7 - imageLinks[index].length];

                    // decode and replace the relative path
                    let imageLink = decodeURI(urlEncodedImageLink).replace(
                        /\.\.\//g,
                        ""
                    );
                    if (imageLink.contains("|")) {
                        imageLink = imageLink.split("|")[0];
                    }

                    const fileName = path.parse(path.basename(imageLink)).name;
                    const imageLinkMd5 = plugin.settings.fileNameEncode
                        ? md5(imageLink)
                        : fileName;
                    const imageExt = path.extname(imageLink);
                    const ifile = plugin.app.metadataCache.getFirstLinkpathDest(
                        imageLink,
                        contentPath
                    );

                    const filePath =
                        ifile !== null
                            ? ifile.path
                            : path.join(path.dirname(contentPath), imageLink);

                    // filter markdown link eg: http://xxx.png
                    if (urlEncodedImageLink.startsWith("http")) {
                        continue;
                    }

                    const targetPath = path
                        .join(
                            plugin.settings.relAttachPath
                                ? plugin.settings.output
                                : plugin.settings.attachment,
                            plugin.settings.includeFileName
                                ? filename.replace(".md", "")
                                : "",
                            plugin.settings.relAttachPath
                                ? plugin.settings.attachment
                                : "",
                            imageLinkMd5.concat(imageExt)
                        )
                        .replace(/\\/g, "/");

                    try {
                        if (!fileExists(targetPath)) {
                            if (
                                plugin.settings.output.startsWith("/") ||
                                path.win32.isAbsolute(plugin.settings.output)
                            ) {
                                const resourceOsPath = getResourceOsPath(
                                    plugin,
                                    ifile
                                );
                                fs.copyFileSync(resourceOsPath, targetPath);
                            } else {
                                await plugin.app.vault.adapter.copy(
                                    filePath,
                                    targetPath
                                );
                            }
                        }
                    } catch (error) {
                        console.error(
                            `Failed to copy file from ${filePath} to ${targetPath}: ${error.message}`
                        );
                    }
                }
            });
    } catch (error) {
        if (!error.message.contains("file already exists")) {
            throw error;
        }
    }
}

export async function tryCopyMarkdown(
    plugin: MarkdownExportPlugin,
    contentPath: string,
    contentName: string
) {
    try {
        await plugin.app.vault.adapter.copy(
            contentPath,
            path.join(plugin.settings.output, contentName)
        );
    } catch (error) {
        if (!error.message.contains("file already exists")) {
            throw error;
        }
    }
}

export async function getEmbedMap(
    plugin: MarkdownExportPlugin,
    content: string,
    path: string
) {
    const embedMap = new Map<string, string>();
    const embeds = Array.from(content.matchAll(EMBED_URL_REGEXP));

    for (const embed of embeds) {
        const embedLink = embed[1]; // This is the link text, e.g., "My Other Note"
        if (!embedLink) continue;

        const sourcePath = path; // The path of the file being exported
        const embeddedFile = plugin.app.metadataCache.getFirstLinkpathDest(
            embedLink,
            sourcePath
        );

        if (embeddedFile instanceof TFile) {
            let embedValue = await plugin.app.vault.read(embeddedFile); // Read raw markdown

            if (plugin.settings.removeYamlHeader) {
                embedValue = embedValue.replace(EMBED_METADATA_REGEXP, "");
            }

            embedMap.set(embedLink, embedValue);
        }
    }
    return embedMap;
}

// ++++++++++++++++ START: NEW AND REFACTORED CODE ++++++++++++++++

/**
 * Generates the final markdown content string by processing images, links, and embeds.
 * This function does NOT perform any file I/O other than reading embedded files.
 */
export async function generateMarkdownContent(
    plugin: MarkdownExportPlugin,
    file: TAbstractFile,
    fileContent: string,
    outputSubPath = "."
): Promise<string> {
    let processedContent = fileContent;

    const imageLinks = await getImageLinks(processedContent);
    for (const index in imageLinks) {
        const rawImageLink = imageLinks[index][0];

        const urlEncodedImageLink =
            imageLinks[index][7 - imageLinks[index].length];
        
        // filter markdown link eg: http://xxx.png
        if (urlEncodedImageLink.startsWith("http")) {
            continue;
        }

        // decode and replace the relative path
        let imageLink = decodeURI(urlEncodedImageLink).replace(
            /\.\.\//g,
            ""
        );
        // link: https://help.obsidian.md/Linking+notes+and+files/Embedding+files#Embed+an+image+in+a+note
        // issue: #44 -> figure checkout: ![[name|figure]]
        if (imageLink.contains("|")) {
            imageLink = imageLink.split("|")[0];
        }
        const fileName = path.parse(path.basename(imageLink)).name;
        const imageLinkMd5 = plugin.settings.fileNameEncode
            ? md5(imageLink)
            : encodeURI(fileName);
        const imageExt = path.extname(imageLink);
        // Unify the link separator in obsidian as a forward slash instead of the default back slash in windows, so that the referenced images can be displayed properly

        const clickSubRoute = getClickSubRoute(outputSubPath);

        const hashLink = path
            .join(
                clickSubRoute,
                plugin.settings.relAttachPath
                    ? plugin.settings.attachment
                    : path.join(
                          plugin.settings.customAttachPath
                              ? plugin.settings.customAttachPath
                              : plugin.settings.attachment,
                          plugin.settings.includeFileName
                              ? file.name.replace(".md", "")
                              : ""
                      ),
                imageLinkMd5.concat(imageExt)
            )
            .replace(/\\/g, "/");

        if (plugin.settings.GFM) {
            processedContent = processedContent.replace(
                rawImageLink,
                GFM_IMAGE_FORMAT.format(hashLink)
            );
        } else {
            processedContent = processedContent.replace(urlEncodedImageLink, hashLink);
        }
    }

    if (plugin.settings.removeOutgoingLinkBrackets) {
        processedContent = processedContent.replaceAll(OUTGOING_LINK_REGEXP, "$1");
    }
    
    // This should come after removeOutgoingLinkBrackets to avoid conflicts
    if (plugin.settings.convertWikiLinksToMarkdown) {
        processedContent = processedContent.replace(
            OUTGOING_LINK_REGEXP,
            (match, linkText) => {
                const parts = linkText.split("|");
                const noteName = parts[0];
                const alias = parts[1] || noteName;
                const encodedLink = encodeURIComponent(noteName) + ".md";
                return `[${alias}](${encodedLink})`;
            }
        );
    }
    
    const embedMap = await getEmbedMap(plugin, processedContent, file.path);
    const embeds = await getEmbeds(processedContent);
    for (const index in embeds) {
        const url = embeds[index][1];
        const embedContent = embedMap.get(url);
        if (embedContent !== undefined) {
            processedContent = processedContent.replace(
                embeds[index][0],
                embedContent
            );
        }
    }

    return processedContent;
}

export async function tryCopyMarkdownByRead(
    plugin: MarkdownExportPlugin,
    { file, outputSubPath = "." }: CopyMarkdownOptions
) {
    try {
        const content = await plugin.app.vault.adapter.read(file.path);
        
        // 1. Generate the processed markdown content
        const processedContent = await generateMarkdownContent(plugin, file, content, outputSubPath);

        // 2. Perform all file I/O side effects
        const imageLinks = await getImageLinks(content);
        if (imageLinks.length > 0) {
            await tryCreateFolder(
                plugin,
                path.join(
                    plugin.settings.relAttachPath
                        ? plugin.settings.output
                        : plugin.settings.attachment,
                    plugin.settings.includeFileName
                        ? file.name.replace(".md", "")
                        : "",
                    plugin.settings.relAttachPath
                        ? plugin.settings.attachment
                        : ""
                )
            );
        }

        await tryCopyImage(plugin, file.name, file.path);

        const outDir = path.join(
            plugin.settings.output,
            plugin.settings.customFileName != "" ||
                (plugin.settings.includeFileName &&
                    plugin.settings.relAttachPath)
                ? file.name.replace(".md", "")
                : "",
            outputSubPath
        );

        await tryCreateFolder(plugin, outDir);

        let filename;
        if (plugin.settings.customFileName) {
            filename = plugin.settings.customFileName + ".md";
        } else {
            filename = file.name;
        }
        const targetFile = path.join(outDir, filename);
        await tryCreate(plugin, targetFile, processedContent);
    } catch (error) {
        if (!error.message.contains("file already exists")) {
            throw error;
        }
    }
}
