/**
 * The Tasks page's height rules (demo audit P1 #5). On a desktop the page is one screen: the board fills what the
 * filters leave and its columns scroll. On a phone the page scrolls instead: the board keeps its natural height, at
 * least most of a screen, so the filters, the add-task form and Find help never squeeze it into a strip.
 */
export const TASKS_PAGE_BODY = 'flex flex-col md:h-full md:min-h-[600px]'
export const TASKS_BOARD = 'min-h-[60vh] md:min-h-0 md:flex-1'
/**
 * The composed screen inside the page body: its parts a little closer than the default, and, on a desktop, the part
 * holding the board (whichever view MeTTa placed) fills what is left, as the board does inside it.
 */
export const TASKS_SCREEN =
  'flex flex-col gap-2 [&>*]:mt-0 [&>*]:mb-0 md:min-h-0 md:flex-1 [&>*:has(>[data-tasks-board])]:flex [&>*:has(>[data-tasks-board])]:flex-col md:[&>*:has(>[data-tasks-board])]:min-h-0 md:[&>*:has(>[data-tasks-board])]:flex-1'
/** The frame the page puts round the board it offers as an island. */
export const TASKS_BOARD_PART = 'flex flex-col md:min-h-0 md:flex-1'
