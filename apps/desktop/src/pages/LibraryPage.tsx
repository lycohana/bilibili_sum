import { useEffect, useState } from "react";

import type { LibraryFilter, Snapshot } from "../appModel";
import { SearchIcon } from "../components/AppIcons";
import { Metric } from "../components/AppPrimitives";
import { VideoCard } from "../components/VideoCard";
import type { VideoAssetSummary } from "../types";

const VIDEOS_PER_PAGE = 16;

function buildPaginationItems(currentPage: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_item, index) => index + 1);
  }

  if (currentPage <= 3) {
    return [1, 2, 3, 4, "ellipsis", totalPages];
  }

  if (currentPage >= totalPages - 2) {
    return [1, "ellipsis", totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}

type LibraryPageProps = {
  snapshot: Snapshot;
  filteredVideos: VideoAssetSummary[];
  libraryCounts: { total: number; completed: number; running: number; withResult: number; favorite: number };
  latestVideo: VideoAssetSummary | null;
  query: string;
  setQuery(value: string): void;
  activeFilter: LibraryFilter;
  setLibraryFilter(value: LibraryFilter): void;
  serviceOnline: boolean;
  runtimeDeviceLabel: string;
  onToggleFavorite(videoId: string, nextFavorite: boolean): Promise<void>;
};

export function LibraryPage({
  snapshot,
  filteredVideos,
  libraryCounts,
  latestVideo,
  query,
  setQuery,
  activeFilter,
  setLibraryFilter,
  serviceOnline,
  runtimeDeviceLabel,
  onToggleFavorite,
}: LibraryPageProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const showWithResultMetric = libraryCounts.withResult !== libraryCounts.completed;
  const filters: Array<{ id: LibraryFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: libraryCounts.total },
    { id: "favorite", label: "收藏", count: libraryCounts.favorite },
    { id: "completed", label: "已完成", count: libraryCounts.completed },
    { id: "running", label: "处理中", count: libraryCounts.running },
    ...(showWithResultMetric ? [{ id: "with-result" as const, label: "有结果", count: libraryCounts.withResult }] : []),
  ];
  const activeFilterLabel = filters.find((filter) => filter.id === activeFilter)?.label || "全部";
  const summaryText = latestVideo
    ? `最近更新：${latestVideo.title}`
    : "输入链接后，视频会自动进入这里统一管理。";
  const totalPages = Math.max(1, Math.ceil(filteredVideos.length / VIDEOS_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = (safeCurrentPage - 1) * VIDEOS_PER_PAGE;
  const pagedVideos = filteredVideos.slice(pageStartIndex, pageStartIndex + VIDEOS_PER_PAGE);
  const paginationItems = buildPaginationItems(safeCurrentPage, totalPages);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter, query]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  return (
    <section className="library-page">
      <section className="library-hero">
        <div className="library-hero-copy">
          <span className="library-kicker">Library</span>
          <h2>视频资产与摘要结果</h2>
          <p>{summaryText}</p>
        </div>
        <div className="library-hero-status">
          <span className={`helper-chip ${serviceOnline ? "status-success" : "status-pending"}`}>
            {serviceOnline ? "服务在线" : "服务离线"}
          </span>
          <span className="helper-chip">{runtimeDeviceLabel}</span>
          <span className="helper-chip">筛选：{activeFilterLabel}</span>
        </div>
      </section>

      <section className="library-summary-panel">
        <div className="library-summary-grid">
          <Metric label="视频总数" value={String(libraryCounts.total)} detail="本地已收录资产" tone="accent" />
          <Metric label="已收藏" value={String(libraryCounts.favorite)} detail="重点沉淀内容" tone="info" />
          <Metric label="已完成" value={String(libraryCounts.completed)} detail="可查看完整摘要" tone="success" />
          <Metric label="处理中" value={String(libraryCounts.running)} detail="正在进行转写或总结" tone="info" />
          {showWithResultMetric ? <Metric label="有结果" value={String(libraryCounts.withResult)} detail="摘要结果已沉淀" /> : null}
        </div>
      </section>

      <section className="library-collection">
        <div className="library-toolbar">
          <div className="library-toolbar-copy">
            <h3>视频库</h3>
            <p>共 {snapshot.videos.length} 个视频资产，当前第 {safeCurrentPage} / {totalPages} 页</p>
          </div>
          <label className="search-field library-search-field">
            <span className="search-icon" aria-hidden="true"><SearchIcon /></span>
            <input
              className="input-field input-field-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题或来源链接..."
            />
          </label>
        </div>

        <div className="filter-pill-row library-filter-row">
          {filters.map((filter) => (
            <button
              key={filter.id}
              className={`filter-pill ${activeFilter === filter.id ? "active" : ""}`}
              type="button"
              onClick={() => setLibraryFilter(filter.id)}
            >
              <span>{filter.label}</span>
              <strong>{filter.count}</strong>
            </button>
          ))}
        </div>

        {filteredVideos.length ? (
          <>
            <div className="video-grid">
              {pagedVideos.map((video) => (
                <VideoCard
                  key={video.video_id}
                  video={video}
                  onToggleFavorite={onToggleFavorite}
                />
              ))}
            </div>

            {totalPages > 1 ? (
              <div className="library-pagination" aria-label="视频库分页">
                <div className="library-pagination-summary">
                  显示第 {pageStartIndex + 1}-{Math.min(pageStartIndex + pagedVideos.length, filteredVideos.length)} 条，共 {filteredVideos.length} 条
                </div>
                <div className="library-pagination-actions">
                  <button
                    className="library-pagination-button"
                    type="button"
                    disabled={safeCurrentPage === 1}
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  >
                    上一页
                  </button>

                  {paginationItems.map((item, index) => {
                    if (item === "ellipsis") {
                      return <span key={`ellipsis-${index}`} className="library-pagination-ellipsis">...</span>;
                    }

                    const pageNumber = item;
                    return (
                      <span key={pageNumber} className="library-pagination-slot">
                        <button
                          className={`library-pagination-button ${pageNumber === safeCurrentPage ? "is-active" : ""}`}
                          type="button"
                          onClick={() => setCurrentPage(pageNumber)}
                          aria-current={pageNumber === safeCurrentPage ? "page" : undefined}
                        >
                          {pageNumber}
                        </button>
                      </span>
                    );
                  })}

                  <button
                    className="library-pagination-button"
                    type="button"
                    disabled={safeCurrentPage === totalPages}
                    onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                  >
                    下一页
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="library-empty-state">
            <div className="library-empty-visual" aria-hidden="true">
              <SearchIcon width={34} height={34} />
            </div>
            <div className="library-empty-copy">
              <h4>当前筛选条件下还没有视频</h4>
              <p>可以调整筛选条件，或者回到首页输入一个视频链接开始生成摘要。</p>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
