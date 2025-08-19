using System;
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace PixieVisio.Server.Models
{
    [Table("nodes")]
    public class Node
    {
        [Key]
        public string Id { get; set; } = Guid.NewGuid().ToString();

        // optional: group multiple nodes into a model
        public string ModelId { get; set; } = "default";

        public double X { get; set; }
        public double Y { get; set; }

        public string Text { get; set; } = string.Empty;
    }
}
