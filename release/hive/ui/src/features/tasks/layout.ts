/**
 * The Tasks page's height rules (demo audit P1 #5). On a desktop the page is one screen: the board fills what the
 * filters leave and its columns scroll. On a phone the page scrolls instead: the board keeps its natural height, at
 * least most of a screen, so the filters, the add-task form and Find help never squeeze it into a strip.
 */
export const TASKS_PAGE_BODY = 'flex flex-col md:h-full md:min-h-[600px]'
export const TASKS_BOARD = 'min-h-[60vh] md:min-h-0 md:flex-1'
