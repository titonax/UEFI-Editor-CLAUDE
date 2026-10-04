// The phrases the firmware extractor puts in its error text when its search for
// Setup was incomplete. Kept in one place because several modules read the
// message back: the corpus runner decides between "unsupported" and "failed"
// from it (amiFirmwareImage.ts's sniffNonAmiFailure) and the dashboard files it
// under a failure code (corpusDashboard.ts). The message crosses a Web Worker
// boundary as text, so the wording is the contract.

// Some sections of the image could not be decompressed.
export const decodeFailedPhrase = "could not be decoded";
// The breadth-first search stopped before it had looked at every decoded buffer.
export const notSearchedPhrase = "were not searched";

// True when the extractor says part of the image was not searched or not
// decoded, so a "Setup was not found" outcome says nothing about whether the
// image has an AMI Setup: it may sit in exactly that part.
export function isIncompleteSearchMessage(message: string): boolean {
  return message.includes(decodeFailedPhrase) || message.includes(notSearchedPhrase);
}
