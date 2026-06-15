namespace Quarry;

public interface IQueryBackend
{
    ColumnSchema GetSchema(string datasetPath);
    long CountRows(string datasetPath, SqlFilter filter);
    string GetPromptAt(string datasetPath, string promptColumn, SqlFilter filter, long index);
    (string Value, bool Matches) GetCandidateAt(string datasetPath, string promptColumn, SqlFilter filter, long index);
}
