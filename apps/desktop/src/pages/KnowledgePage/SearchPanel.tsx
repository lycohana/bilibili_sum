import { Link } from "react-router-dom";

import { SearchIcon } from "../../components/AppIcons";
import type { KnowledgeSearchResult, KnowledgeTagItem } from "../../types";

type SearchPanelProps = {
  query: string;
  onQueryChange(value: string): void;
  results: KnowledgeSearchResult[];
  selectedTags: string[];
  allTags: KnowledgeTagItem[];
  onToggleTag(tag: string): void;
  onManageTags(videoId: string): void;
  searching: boolean;
  statsSummary: Array<{ label: string; value: string | number }>;
};

export function SearchPanel({
  query,
  onQueryChange,
  results,
  selectedTags,
  allTags,
  onToggleTag,
  onManageTags,
  searching,
  statsSummary,
}: SearchPanelProps) {
  return (
    <div className="knowledge-workbench-grid">
      <div className="knowledge-panel-card knowledge-sidebar-card">
        <div className="knowledge-section-head">
          <div>
            <h3>工作台概览</h3>
            <p>先筛标签，再搜索命中内容。</p>
          </div>
        </div>
        <div className="knowledge-stats-grid">
          {statsSummary.map((item) => (
            <div key={item.label} className="knowledge-stat-chip">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
        <div className="knowledge-sidebar-section">
          <div className="knowledge-section-title-row">
            <strong>已选标签</strong>
            {selectedTags.length ? (
              <button className="tertiary-button" type="button" onClick={() => selectedTags.forEach((tag) => onToggleTag(tag))}>
                清空
              </button>
            ) : null}
          </div>
          <div className="filter-pill-row">
            {selectedTags.length ? selectedTags.map((tag) => (
              <button key={tag} className="filter-pill active" type="button" onClick={() => onToggleTag(tag)}>
                <span>{tag}</span>
              </button>
            )) : <span className="knowledge-muted-copy">还没有筛选标签。</span>}
          </div>
        </div>
        <div className="knowledge-sidebar-section">
          <div className="knowledge-section-title-row">
            <strong>热门标签</strong>
          </div>
          <div className="knowledge-tag-cloud">
            {allTags.slice(0, 18).map((tag) => (
              <button
                key={tag.tag}
                className={`filter-pill ${selectedTags.includes(tag.tag) ? "active" : ""}`}
                type="button"
                onClick={() => onToggleTag(tag.tag)}
              >
                <span>{tag.tag}</span>
                <strong>{tag.count}</strong>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="knowledge-panel-card knowledge-results-card">
        <div className="knowledge-section-head">
          <div>
            <h3>语义搜索</h3>
            <p>把标签筛选和片段级命中放在一起看。</p>
          </div>
        </div>
        <label className="search-field knowledge-search-field">
          <span className="search-icon" aria-hidden="true"><SearchIcon /></span>
          <input
            className="input-field input-field-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="输入主题、问题或术语，例如：注意力机制、答题卡识别、OpenCV"
          />
        </label>
        <div className="knowledge-result-list">
          {searching ? <div className="knowledge-empty-state">正在搜索知识库...</div> : null}
          {!searching && !results.length ? (
            <div className="knowledge-empty-state">
              {query.trim() ? "没有找到更合适的命中结果，可以换个问法或先用标签缩小范围。" : "输入关键词后，这里会展示最相关的视频片段和命中摘要。"}
            </div>
          ) : null}
          {results.map((result) => (
            <article key={`${result.video_id}-${result.timestamp || "na"}`} className="knowledge-result-card">
              <div className="knowledge-result-head">
                <div>
                  <h4>
                    <Link to={`/videos/${result.video_id}`}>{result.title}</Link>
                  </h4>
                  <p>相关度 {Math.round(result.relevance_score * 100)}%{result.timestamp ? ` · ${result.timestamp}` : ""}</p>
                </div>
                <div className="knowledge-result-actions">
                  <button className="tertiary-button" type="button" onClick={() => onManageTags(result.video_id)}>标签</button>
                </div>
              </div>
              <p className="knowledge-result-snippet">{result.snippet}</p>
              <div className="filter-pill-row">
                {result.tags.map((tag) => (
                  <button
                    key={`${result.video_id}-${tag}`}
                    className={`filter-pill ${selectedTags.includes(tag) ? "active" : ""}`}
                    type="button"
                    onClick={() => onToggleTag(tag)}
                  >
                    <span>{tag}</span>
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
