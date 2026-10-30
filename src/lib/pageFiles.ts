/** What page upload pickers accept: any image, and Photoshop files, which are flattened to PNG. */
export const PAGE_FILE_ACCEPT = "image/*,.psd";

export const isPsdFile = (file: File) => /\.psd$/i.test(file.name) || file.type === "image/vnd.adobe.photoshop";

/** Browsers report PSDs as `image/vnd.adobe.photoshop`, or with no type at all. */
export const isPageFile = (file: File) => file.type.startsWith("image/") || isPsdFile(file);
