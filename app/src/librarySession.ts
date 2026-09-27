import { createContext, useContext } from "react";

/** 切库后旧请求持有的代次会失效，避免迟到结果继续更新界面或发起后续操作。 */
export interface LibrarySessionScope {
  id: number;
  isCurrent(id: number): boolean;
}

const defaultScope: LibrarySessionScope = {
  id: 0,
  isCurrent: (id) => id === 0,
};

export const LibrarySessionContext = createContext(defaultScope);

export function useLibrarySession(): LibrarySessionScope {
  return useContext(LibrarySessionContext);
}
