import { createContext } from 'react';

/**
 * Whose feed the components below are drawing. The main chat has none (the defaults); a subagent's tab names the Agent call
 * (`agent`) and whether the subagent still runs (`busy`), which stands in for the main feed's busy flag.
 */
export const FeedScope = createContext<{ agent?: string; busy?: boolean }>({});
